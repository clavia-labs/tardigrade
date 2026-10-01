import { Context, Effect, Exit, Random, Semaphore } from "effect"
import { RuntimeError } from "../runtime/effects"
import type { ChildPlacement, ThreadCoordinate } from "../actor/thread"
import type { Journal } from "./journal"
import { Provision, supervisorActor, type SupervisorEvent, type ThreadAllocation } from "./supervisor/graph"
import { createActorStore } from "../runtime/execution"
import { createSupervisorStore, type SupervisorStore } from "../runtime/stores/supervisor"

export interface ThreadRequest {
  readonly instance: string
  readonly parent?: ThreadCoordinate
  readonly name?: string
  readonly placement?: ChildPlacement
}

// Supervisor allocates threads and exposes their durable registration directory within a hosted actor type.
export class Supervisor extends Context.Service<Supervisor, {
  readonly allocate: (request: ThreadRequest) => Effect.Effect<ThreadCoordinate, Error>
  readonly lookup: (coordinate: ThreadCoordinate) => Effect.Effect<ThreadCoordinate | undefined, Error>
  readonly store: (instance: string) => Effect.Effect<SupervisorStore, Error>
}>()("experimental/Supervisor") {}

// createSupervisor manages per-instance directory actors and provisions their requested threads.
export function createSupervisor(options: {
  readonly actor: string
  readonly journal: (instance: string) => Journal<SupervisorEvent>
  readonly provision: (allocation: ThreadAllocation) => Effect.Effect<void, Error>
  readonly generateName?: () => string
  readonly defaultChildPlacement: ChildPlacement
  readonly supportedChildPlacements: readonly ChildPlacement[]
  readonly run: <Value>(work: Effect.Effect<Value, Error>) => Effect.Effect<Value, Error>
}) {
  if (!options.supportedChildPlacements.includes(options.defaultChildPlacement)) throw new RuntimeError("Default child placement is unsupported")
  const openSupervisor = (instance: string) => createActorStore({
    actor: supervisorActor,
    journal: options.journal(instance),
    actorContext: () => Context.empty(),
    services: () => Provision.layer(allocation => options.provision(allocation).pipe(Effect.as(null), Effect.mapError(String))),
  })
  const supervisors = new Map<string, ReturnType<typeof openSupervisor>>()
  const locks = new Map<string, Semaphore.Semaphore>()
  const serialize = <Value>(key: string, work: Effect.Effect<Value, Error>) => Effect.suspend(() => {
    let lock = locks.get(key)
    if (!lock) { lock = Semaphore.makeUnsafe(1); locks.set(key, lock) }
    return lock.withPermit(work)
  })
  const randomName = Effect.gen(function* () { return `${yield* Random.nextInt}-${yield* Random.nextInt}` })
  const supervisorFor = (instance: string) => Effect.gen(function* () {
    if (!instance) return yield* Effect.fail(new RuntimeError("Actor instance must be nonempty"))
    let pending = supervisors.get(instance)
    if (!pending) {
      pending = yield* Effect.cached(openSupervisor(instance).pipe(Effect.flatMap(supervisor =>
        supervisor.resume.pipe(Effect.andThen(supervisor.wait), Effect.as(supervisor), Effect.onError(() => supervisor.close)),
      ), Effect.onError(() => Effect.sync(() => { supervisors.delete(instance) }))))
      supervisors.set(instance, pending)
    }
    return yield* pending
  })
  const allocate = (instance: string, parent: ThreadCoordinate | undefined, suppliedName: string | undefined, requestedPlacement: ChildPlacement | undefined) => serialize(`allocate:${instance}`, Effect.gen(function* () {
    const placement = requestedPlacement ?? options.defaultChildPlacement
    if (!options.supportedChildPlacements.includes(placement)) return yield* Effect.fail(new RuntimeError(`Unsupported child placement: ${placement}`))
    if (parent && (parent.actor !== options.actor || parent.instance !== instance)) return yield* Effect.fail(new RuntimeError("Parent belongs to another actor instance"))
    const supervisor = yield* supervisorFor(instance)
    const directory = supervisor.getState().view.threads
    const ancestor = parent ? directory.find(entry => entry.coordinate.thread === parent.thread && entry.status === "registered") : undefined
    if (parent && !ancestor) return yield* Effect.fail(new RuntimeError("Unknown parent thread"))
    const name = suppliedName ?? (options.generateName ? yield* Effect.try({ try: options.generateName, catch: RuntimeError.from }) : yield* randomName)
    if (!name || name.includes("/")) return yield* Effect.fail(new RuntimeError("Thread name must be nonempty and contain no slash"))
    const existing = directory.find(entry => entry.name === name && entry.parent === (parent?.thread ?? null))
    if (existing) {
      if (requestedPlacement !== undefined && existing.placement !== requestedPlacement) return yield* Effect.fail(new RuntimeError("Named thread already has different placement"))
      if (suppliedName === undefined) return yield* Effect.fail(new RuntimeError("Generated thread name already exists; supply a different name or generator"))
      yield* supervisor.resume
      yield* supervisor.wait
      const allocated = supervisor.getState().view.threads.find(entry => entry.coordinate.thread === existing.coordinate.thread)
      if (allocated?.status !== "registered") return yield* Effect.fail(new RuntimeError(allocated?.reason ?? "Thread provisioning did not complete"))
      return Object.freeze({ ...existing.coordinate })
    }
    const thread = directory.some(entry => entry.coordinate.thread === name) ? `${name}-${yield* randomName}` : name
    if (directory.some(entry => entry.coordinate.thread === thread)) return yield* Effect.fail(new RuntimeError("Thread identity collision"))
    const coordinate = { actor: options.actor, instance, thread }
    yield* supervisor.actions.requestThread({ coordinate, name, parent: parent?.thread ?? null, depth: ancestor ? ancestor.depth + 1 : 0, placement })
    yield* supervisor.wait
    const allocated = supervisor.getState().view.threads.find(entry => entry.coordinate.thread === coordinate.thread)
    if (allocated?.status !== "registered") return yield* Effect.fail(new RuntimeError(allocated?.reason ?? "Thread provisioning did not complete"))
    return Object.freeze({ ...coordinate })
  }))
  const lookup = (coordinate: ThreadCoordinate) => Effect.gen(function* () {
    if (coordinate.actor !== options.actor) return yield* Effect.fail(new RuntimeError(`Unknown actor: ${coordinate.actor}`))
    const supervisor = yield* supervisorFor(coordinate.instance)
    const entry = supervisor.getState().view.threads.find(thread => thread.coordinate.thread === coordinate.thread && thread.status === "registered")
    return entry ? Object.freeze({ ...entry.coordinate }) : undefined
  })
  return {
    allocate: (request: ThreadRequest) => options.run(allocate(request.instance, request.parent, request.name, request.placement)),
    lookup: (coordinate: ThreadCoordinate) => options.run(lookup(coordinate)),
    store: (instance: string) => options.run(supervisorFor(instance).pipe(Effect.map(createSupervisorStore))),
    close: Effect.gen(function* () {
      const results = yield* Effect.forEach(supervisors.values(), pending =>
        Effect.exit(Effect.gen(function* () { const supervisor = yield* pending; yield* supervisor.close })),
      )
      const failure = results.find(Exit.isFailure)
      if (failure && Exit.isFailure(failure)) return yield* Effect.failCause(failure.cause)
    }),
  } satisfies typeof Supervisor.Service & { readonly close: Effect.Effect<void, Error> }
}
