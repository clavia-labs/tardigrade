import type { ThreadCoordinate } from "./contracts"
import { ThreadProvisioner, provisionThreads } from "./services/provision"
import { RuntimeError, type ActorRuntime, type Atom, type Journal, type ActorDefinition, type Requirements } from "@clavia/tardigrade-experimental-core"
import { supervisorActor, type SupervisorEvent } from "./supervisor"
import { invocationLedger, type InvocationEvent, type InvocationOptions, type ThreadMethods } from "./invocation"
import { createActorStore } from "./runtime"
import { Context, Effect, Layer, Scope, Semaphore, Exit, Fiber, Random } from "effect"
import { createThreadStore } from "./stores/thread"
import { createSupervisorStore } from "./stores/supervisor"

export interface ThreadStorage<Event extends object> {
  readonly supervisor: (actor: string, instance: string) => Journal<SupervisorEvent>
  readonly thread: (coordinate: ThreadCoordinate) => Journal<Event>
  readonly invocations: (coordinate: ThreadCoordinate) => Journal<InvocationEvent>
  readonly close: Effect.Effect<void, Error>
}

export interface ManagedThread<Methods, State> {
  readonly methods: Methods
  readonly get: <Value>(node: Atom<Value>) => Value
  readonly sub: <Value>(node: Atom<Value>, listener: () => void) => () => void
  readonly getState: () => State
  readonly resume: Effect.Effect<void, Error>
  readonly wait: Effect.Effect<void, Error>
  readonly close: Effect.Effect<void, Error>
}

export type HostedActor<Event extends object, Services, Methods extends object, State> = ActorDefinition<Event, State, Methods, Services>

// createThreadHost allocates scoped thread identities and serializes local allocation and invocation admission.
export function createThreadHost<Event extends object, Services, Methods extends Readonly<Record<string, (...args: never[]) => Effect.Effect<void, Error>>>, State>(options: {
  readonly actor: HostedActor<Event, Services, Methods, State>
  readonly storage: ThreadStorage<Event>
  readonly services: (coordinate: ThreadCoordinate, runtime: ActorRuntime<Event>) => Layer.Layer<Requirements<{ root: Atom<State> }> | Exclude<Services, Scope.Scope>, Error>
  readonly actorContext: (services: Context.Context<Requirements<{ root: Atom<State> }> | Exclude<Services, Scope.Scope>>) => Context.Context<Exclude<Services, Scope.Scope>>
  readonly generateName?: () => string
}) {
  const createSupervisor = (instance: string) => createActorStore({
    actor: supervisorActor,
    journal: options.storage.supervisor(options.actor.actorName, instance),
    actorContext: () => Context.empty(),
    services: () => provisionThreads.pipe(Layer.provide(Layer.succeed(ThreadProvisioner, {
      provision: allocation => open(allocation.coordinate).pipe(Effect.asVoid),
    }))),
  })
  const supervisors = new Map<string, ReturnType<typeof createSupervisor>>()
  const threads = new Map<string, Effect.Effect<ManagedThread<Methods, State>, Error>>()
  const ledgers = new Map<string, ReturnType<typeof invocationLedger>>()
  const locks = new Map<string, Semaphore.Semaphore>()
  const scope = Scope.makeUnsafe()
  let closed = false
  const check = Effect.suspend(() => closed ? Effect.fail(new RuntimeError("Thread host is closed")) : Effect.void)
  const run = <Value>(work: Effect.Effect<Value, Error>) => check.pipe(Effect.andThen(Effect.acquireUseRelease(work.pipe(Effect.forkIn(scope)), Fiber.join, Fiber.interrupt)))
  const serialize = <Value>(key: string, work: Effect.Effect<Value, Error>) => Effect.suspend(() => {
    let lock = locks.get(key)
    if (!lock) { lock = Semaphore.makeUnsafe(1); locks.set(key, lock) }
    return lock.withPermit(work)
  })
  const randomName = Effect.gen(function* () { return `${yield* Random.nextInt}-${yield* Random.nextInt}` })
  const identity = (coordinate: ThreadCoordinate) => JSON.stringify([coordinate.actor, coordinate.instance, coordinate.thread])
  const open = (coordinate: ThreadCoordinate): Effect.Effect<ManagedThread<Methods, State>, Error> => Effect.gen(function* () {
    const key = identity(coordinate)
    let pending = threads.get(key)
    if (!pending) {
      pending = yield* Effect.cached(createActorStore<Event, State, Methods, Services>({
        actor: options.actor, actorContext: options.actorContext, journal: options.storage.thread(coordinate), services: runtime => options.services(coordinate, runtime),
      }).pipe(Effect.onError(() => Effect.sync(() => { threads.delete(key) }))))
      threads.set(key, pending)
    }
    return yield* pending
  })
  const supervisorFor = (instance: string) => Effect.gen(function* () {
    if (!instance) return yield* Effect.fail(new RuntimeError("Actor instance must be nonempty"))
    let pending = supervisors.get(instance)
    if (!pending) {
      pending = yield* Effect.cached(createSupervisor(instance).pipe(Effect.flatMap(supervisor =>
        supervisor.resume.pipe(Effect.andThen(supervisor.wait), Effect.as(supervisor), Effect.onError(() => supervisor.close)),
      ), Effect.onError(() => Effect.sync(() => { supervisors.delete(instance) }))))
      supervisors.set(instance, pending)
    }
    return yield* pending
  })
  const reference = (coordinate: ThreadCoordinate) => Effect.gen(function* () {
    const thread = yield* open(coordinate)
    const key = identity(coordinate)
    let ledger = ledgers.get(key)
    if (!ledger) {
      ledger = yield* Effect.cached(invocationLedger(options.storage.invocations(coordinate)))
      ledgers.set(key, ledger)
    }
    const invocations = yield* ledger
    const methods = Object.fromEntries(Object.entries(thread.methods).map(([name, method]) => [name, (...values: unknown[]) => run(Effect.gen(function* () {
      const input = yield* Effect.try({ try: () => structuredClone(values.slice(0, -1)), catch: RuntimeError.from })
      const invocation = values.at(-1) as InvocationOptions | undefined
      if (!invocation || typeof invocation.key !== "string" || !invocation.key) return yield* Effect.fail(new RuntimeError("Invocation key is required"))
      return yield* serialize(`invoke:${key}`, invocations.invoke(invocation.key, name, input, () => method(...input as never[])))
    }))])) as unknown as ThreadMethods<Methods>
    return { coordinate: Object.freeze({ ...coordinate }), store: createThreadStore(coordinate, thread), methods, get: thread.get, getState: thread.getState, resume: thread.resume, wait: thread.wait, invocation: invocations.get }
  })
  const allocate = (instance: string, parent: ThreadCoordinate | undefined, suppliedName?: string) => serialize(`allocate:${instance}`, Effect.gen(function* () {
    if (parent && (parent.actor !== options.actor.actorName || parent.instance !== instance)) return yield* Effect.fail(new RuntimeError("Parent belongs to another actor instance"))
    const supervisor = yield* supervisorFor(instance)
    const directory = supervisor.getState().view.threads
    const ancestor = parent ? directory.find(entry => entry.coordinate.thread === parent.thread && entry.status === "registered") : undefined
    if (parent && !ancestor) return yield* Effect.fail(new RuntimeError("Unknown parent thread"))
    const name = suppliedName ?? (options.generateName ? yield* Effect.try({ try: options.generateName, catch: RuntimeError.from }) : yield* randomName)
    if (!name || name.includes("/")) return yield* Effect.fail(new RuntimeError("Thread name must be nonempty and contain no slash"))
    const existing = directory.find(entry => entry.name === name && entry.parent === (parent?.thread ?? null))
    if (existing) {
      if (suppliedName === undefined) return yield* Effect.fail(new RuntimeError("Generated thread name already exists; supply a different name or generator"))
      yield* supervisor.resume
      yield* supervisor.wait
      const allocated = supervisor.getState().view.threads.find(entry => entry.coordinate.thread === existing.coordinate.thread)
      if (allocated?.status !== "registered") return yield* Effect.fail(new RuntimeError(allocated?.reason ?? "Thread provisioning did not complete"))
      return yield* reference(existing.coordinate)
    }
    const thread = directory.some(entry => entry.coordinate.thread === name) ? `${name}-${yield* randomName}` : name
    if (directory.some(entry => entry.coordinate.thread === thread)) return yield* Effect.fail(new RuntimeError("Thread identity collision"))
    const coordinate = { actor: options.actor.actorName, instance, thread }
    yield* supervisor.methods.requestThread({ coordinate, name, parent: parent?.thread ?? null, depth: ancestor ? ancestor.depth + 1 : 0 })
    yield* supervisor.wait
    const allocated = supervisor.getState().view.threads.find(entry => entry.coordinate.thread === coordinate.thread)
    if (allocated?.status !== "registered") return yield* Effect.fail(new RuntimeError(allocated?.reason ?? "Thread provisioning did not complete"))
    return yield* reference(coordinate)
  }))
  const closing = Effect.runSync(Effect.cached(Effect.gen(function* () {
    closed = true
    yield* Scope.close(scope, Exit.succeed(undefined))
    const results = yield* Effect.forEach([...supervisors.values(), ...threads.values()], pending =>
      Effect.exit(Effect.gen(function* () { const thread = yield* pending; yield* thread.close })),
    )
    yield* options.storage.close
    const failure = results.find(Exit.isFailure)
    if (failure && Exit.isFailure(failure)) return yield* Effect.failCause(failure.cause)
  }).pipe(Effect.uninterruptible)))
  return {
    actor: options.actor.actorName,
    supervisorStore: (instance: string) => run(supervisorFor(instance).pipe(Effect.map(createSupervisorStore))),
    getThread: (input: { readonly instance: string; readonly thread: string }) => run(Effect.gen(function* () {
      const supervisor = yield* supervisorFor(input.instance)
      const entry = supervisor.getState().view.threads.find(thread => thread.coordinate.thread === input.thread && thread.status === "registered")
      return entry ? yield* reference(entry.coordinate) : undefined
    })),
    allocateRootThread: (input: { readonly instance: string; readonly name?: string }) => run(allocate(input.instance, undefined, input.name)),
    allocateChildThread: (input: { readonly parent: ThreadCoordinate; readonly name?: string }) => run(allocate(input.parent.instance, input.parent, input.name)),
    close: closing,
  }
}
