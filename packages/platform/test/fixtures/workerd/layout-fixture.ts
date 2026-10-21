import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { act, actorMethod, defineActor, durableAtom, effectAtom, event, Invocation, Supervisor, ThreadCoordinate, EffectExecution, durablePromise, DEFAULT_PROVISION_RETRY, type ThreadCreated, type InitialState } from "@clavia/tardigrade-core"
import { cloudflareWatchdogStorage } from "../../../src/cloudflare/watchdog"
import { createActorWorker, cloudflareThreadName } from "../../../src/cloudflare"

const ReadRequested = event({ type: "ReadRequested" })
const Changed = event({ type: "Changed", value: Schema.Finite })
const SpawnRequested = event({ type: "SpawnRequested", id: Schema.String, value: Schema.Finite })
const SpawnCompleted = event({ type: "SpawnCompleted", id: Schema.String, child: ThreadCoordinate })
const Event = Schema.Union([Changed, SpawnRequested, SpawnCompleted, ReadRequested])
const value = durableAtom({ name: "layout.value", input: Changed, schema: Schema.Finite, initial: 0, reduce: (_, event) => event.value })
const spawns = durableAtom({ name: "layout.spawns", input: Schema.Union([SpawnRequested, SpawnCompleted]),
  schema: Schema.Array(Schema.Struct({ id: Schema.String, origin: Schema.Finite, value: Schema.Finite, child: Schema.NullOr(ThreadCoordinate) })), initial: [],
  reduce: (state, event, _metadata, position) => event.type === "SpawnRequested" ? [...state, { id: event.id, origin: position, value: event.value, child: null }]
    : state.map(entry => entry.id === event.id ? { ...entry, child: event.child } : entry),
})
const Spawn = act({ name: "layout.spawn", input: Schema.Struct({ id: Schema.String, value: Schema.Finite }), success: ThreadCoordinate, failure: Schema.String })
const actor = defineActor("layout", Effect.sync(() => {
  const requests = new Map<string, ReturnType<typeof Spawn.request>>()
  return { schema: Event, atom: effectAtom(get => {
    const pending = get(spawns)
    return { view: get(value), events: {}, acts: Object.fromEntries(pending.filter(entry => !entry.child).map(entry => {
      let request = requests.get(entry.id)
      if (!request) {
        request = Spawn.request({ origin: entry.origin, input: { id: entry.id, value: entry.value }, onSettled: result => result.status === "fulfilled" ? [{ type: "SpawnCompleted", id: entry.id, child: result.value }] : [] })
        requests.set(entry.id, request)
      }
      return [entry.id, request]
    })) }
  }), methods: {
    read: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Finite, onReceive: ReadRequested.from(() => ({})), result: (_, get) => ({ status: "completed", output: get(value) }) }),
    outcome: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Finite, onReceive: ReadRequested.from(() => ({})), result: (_, get) => ({ status: "completed", output: get(value) }) }),
    set: actorMethod({ inputSchema: Schema.Finite, outputSchema: Schema.Finite, onReceive: Changed.from(value => ({ value })), result: (_, get) => ({ status: "completed", output: get(value) }) }),
    spawn: actorMethod({ inputSchema: Schema.Finite, outputSchema: ThreadCoordinate,
      onReceive: SpawnRequested.from((value, context) => ({ id: context.id, value })), result: (_, get, context) => {
        const child = get(spawns).find(entry => entry.id === context.id)?.child
        return child ? { status: "completed", output: child } : undefined
      },
    }),
  } }
}))

const provisionResets = new Set<string>()
const lookupResets = new Set<string>()
const paused = new Set<string>()
const failed = new Set<string>()
const held = new Map<string, Deferred.Deferred<void>>()
const attempts = new Map<string, number>()
const runtimeLifetimes = new Map<string, { opened: number; closed: number }>()
const lifecycle = (coordinate: ThreadCoordinate) => Layer.effectDiscard(Effect.acquireRelease(Effect.sync(() => {
  const name = cloudflareThreadName(coordinate)
  const counts = runtimeLifetimes.get(name) ?? {opened: 0, closed: 0}
  counts.opened++
  runtimeLifetimes.set(name, counts)
  return counts
}), counts => Effect.sync(() => { counts.closed++ })))
const worker = createActorWorker({ actor, releaseSettledAfter: ["outcome"], provisionRetry: { ...DEFAULT_PROVISION_RETRY, decide: (failure, attempt) => DEFAULT_PROVISION_RETRY.decide(failure, attempt).pipe(Effect.map(decision => decision && { ...decision, delayMs: 50 })) }, checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } }, actorContext: Context.pick(), initialStateAtoms: [value, spawns], http: env => typeof env.FIXTURE_TOKEN === "string" ? { token: env.FIXTURE_TOKEN } : {}, effectInput: { digestMinBytes: 0 }, services: (_env, coordinate) => Spawn.layer(input => Effect.gen(function* () {
  const name = cloudflareThreadName(coordinate)
  attempts.set(name, (attempts.get(name) ?? 0) + 1)
  const execution = yield* EffectExecution
  yield* execution.publish({ type: "tool.progress", message: "spawning" })
  if (failed.has(name)) return yield* Effect.die(new Error("injected spawn defect"))
  if (paused.has(name)) return yield* Effect.never
  const supervisor = yield* Supervisor
  const invocation = yield* Invocation
  const spawn = Effect.gen(function* () {
    const child = yield* supervisor.allocate({ instance: coordinate.instance, parent: coordinate, name: input.id })
    yield* invocation.send({ id: `child:${input.id}`, target: child, body: { method: "set", input: input.value } })
    return child
  }).pipe(Effect.mapError(String))
  const release = held.get(name)
  if (!release) return yield* spawn
  const promise = durablePromise(execution.ref, { success: ThreadCoordinate, error: Schema.String })
  const handle = yield* execution.fork(Deferred.await(release).pipe(Effect.andThen(spawn), Effect.match({ onFailure: promise.fail, onSuccess: promise.succeed })), { timeoutMs: 60_000 })
  return Spawn.defer(handle)
}).pipe(Effect.mapError(String))).pipe(Layer.provideMerge(lifecycle(coordinate))) })
export class LayoutActorDO extends worker.ActorObject {
  resetNextProvision(thread: string) { provisionResets.add(cloudflareThreadName({ actor: "layout", instance: this.ctx.id.name!, thread })) }
  resetNextLookup() { lookupResets.add(this.ctx.id.name!) }
  override async lookup(coordinate: ThreadCoordinate) {
    if (lookupResets.delete(coordinate.instance)) throw Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true })
    return super.lookup(coordinate)
  }
}
export class LayoutThreadDO extends worker.ThreadObject {
  private provisionRelease: Deferred.Deferred<void> | undefined
  private provisionEntered = false
  private provisionAttempts = 0
  private provisionFailures = 0
  failNextProvisions(count: number) { this.provisionFailures = count }
  provisionCalls() { return this.provisionAttempts }
  holdProvision() { this.provisionRelease = Deferred.makeUnsafe<void>() }
  provisioning() { return this.provisionEntered }
  async releaseProvision() {
    if (this.provisionRelease) await Effect.runPromise(Deferred.succeed(this.provisionRelease, undefined))
    this.provisionRelease = undefined
  }
  override async provision(created: ThreadCreated, initialState?: InitialState) {
    this.provisionEntered = true
    this.provisionAttempts++
    if (this.provisionFailures > 0) { this.provisionFailures--; throw new Error("injected transient provision failure") }
    if (this.provisionRelease) await Effect.runPromise(Deferred.await(this.provisionRelease))
    if (created.address.instance.startsWith("parallel-")) await Effect.runPromise(Effect.sleep(200))
    await super.provision(created, initialState)
    if (provisionResets.delete(cloudflareThreadName(created.address))) throw Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true })
  }
  async wake() {
    await Effect.runPromise(cloudflareWatchdogStorage(this.ctx.storage).transaction(tx => Effect.gen(function* () {
      for (const [key, entry] of yield* tx.list) if (entry.status === "pending") yield* tx.put(key, { ...entry, nextWakeAt: 0 })
    })))
    await this.alarm()
  }
  lifetimes() { return runtimeLifetimes.get(this.ctx.id.name!) ?? {opened: 0, closed: 0} }
  executions() { return attempts.get(this.ctx.id.name!) ?? 0 }
  failSpawns(fail: boolean) {
    if (fail) failed.add(this.ctx.id.name!)
    else failed.delete(this.ctx.id.name!)
  }
  holdSpawns() { held.set(this.ctx.id.name!, Deferred.makeUnsafe<void>()) }
  async releaseSpawns() {
    const release = held.get(this.ctx.id.name!)!
    held.delete(this.ctx.id.name!)
    await Effect.runPromise(Deferred.succeed(release, undefined))
  }
  blockSpawns(blocked: boolean) {
    const name = this.ctx.id.name!
    if (blocked) paused.add(name)
    else paused.delete(name)
  }
}
export default { fetch: worker.fetch }
