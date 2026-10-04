import { Context, Deferred, Effect, Schema } from "effect"
import { act, actorMethod, defineActor, durableAtom, effectAtom, event, Invocation, Supervisor, ThreadCoordinate, EffectExecution, durablePromise } from "@clavia/tardigrade-core"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import { createActorWorker, cloudflareThreadName } from "../../src/cloudflare"

const ReadRequested = event({ type: "ReadRequested" })
const Changed = event({ type: "Changed", value: Schema.Finite })
const SpawnRequested = event({ type: "SpawnRequested", id: Schema.String, value: Schema.Finite })
const SpawnCompleted = event({ type: "SpawnCompleted", id: Schema.String, child: ThreadCoordinate })
const Event = Schema.Union([Changed, SpawnRequested, SpawnCompleted, ReadRequested])
const value = durableAtom({ name: "layout.value", input: Changed, schema: Schema.Finite, initial: 0, reduce: (_, event) => event.value })
const spawns = durableAtom({ name: "layout.spawns", input: Schema.Union([SpawnRequested, SpawnCompleted]),
  schema: Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Finite, child: Schema.NullOr(ThreadCoordinate) })), initial: [],
  reduce: (state, event) => event.type === "SpawnRequested" ? [...state, { id: event.id, value: event.value, child: null }]
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
        request = Spawn.request({ tag: entry.id, input: { id: entry.id, value: entry.value }, onSettled: result => result.status === "fulfilled" ? [{ type: "SpawnCompleted", id: entry.id, child: result.value }] : [] })
        requests.set(entry.id, request)
      }
      return [entry.id, request]
    })) }
  }), methods: {
    read: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Finite, onReceive: ReadRequested.from(() => ({})), result: (_, get) => ({ status: "completed", output: get(value) }) }),
    set: actorMethod({ inputSchema: Schema.Finite, outputSchema: Schema.Finite, onReceive: Changed.from(value => ({ value })), result: (_, get) => ({ status: "completed", output: get(value) }) }),
    spawn: actorMethod({ inputSchema: Schema.Finite, outputSchema: ThreadCoordinate,
      onReceive: SpawnRequested.from((value, context) => ({ id: context.id, value })), result: (_, get, context) => {
        const child = get(spawns).find(entry => entry.id === context.id)?.child
        return child ? { status: "completed", output: child } : undefined
      },
    }),
  } }
}))

const paused = new Set<string>()
const failed = new Set<string>()
const held = new Map<string, Deferred.Deferred<void>>()
const attempts = new Map<string, number>()
const worker = createActorWorker({ actor, actorContext: Context.pick(), initialStateAtoms: [value, spawns], http: env => typeof env.FIXTURE_TOKEN === "string" ? { token: env.FIXTURE_TOKEN } : {}, effectInput: { digestMinBytes: 0 }, services: (_env, coordinate) => Spawn.layer(input => Effect.gen(function* () {
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
}).pipe(Effect.mapError(String))) })
export const LayoutActorDO = worker.ActorObject
export class LayoutThreadDO extends worker.ThreadObject {
  async wake() {
    await Effect.runPromise(cloudflareWatchdogStorage(this.ctx.storage).transaction(tx => Effect.gen(function* () {
      for (const [key, entry] of yield* tx.list) if (entry.status === "pending") yield* tx.put(key, { ...entry, nextWakeAt: 0 })
    })))
    await this.alarm()
  }
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
