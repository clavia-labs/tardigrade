import { isDeepStrictEqual } from "node:util"
import type { RecoveryState } from "./watchdog"
import type { PromisePolicy } from "./promises"
import type { InitialState } from "../initialise"
import { EffectExecution, type RetryOptions } from "./effect-execution"
import { Context, Deferred, Effect, Exit, Random, Schema, Semaphore } from "effect"
import { durablePromise } from "../atoms/promise"
import { RuntimeError } from "../runtime/effects"
import type { ChildPlacement, ThreadCoordinate } from "../actor/thread"
import type { Journal } from "./journal"
import { Provision, familySupervisorActor, thread as threadAtom, threadByName, threadNameKey, SUPERVISOR_CHECKPOINT_TAG, type SupervisorEvent, type ThreadAllocation } from "./supervisor/graph"
import { createActorStore, type CheckpointPolicy } from "../runtime/execution"
import type { ActorRuntime } from "../runtime/contracts"
import { createSupervisorStore, type SupervisorStore } from "../runtime/stores/supervisor"
export { DEFAULT_SUPERVISOR_PAGE_SIZE, type SupervisorPageOptions } from "./supervisor/page"

export const DEFAULT_PROVISION_RETRY_LIMIT = 2
export const DEFAULT_PROVISION_RETRY_INTERVAL_MS = 1_000
export const DEFAULT_SUPERVISOR_JOURNAL_READ_BATCH_SIZE = 16
// DEFAULT_PROVISION_RETRY bounds typed provisioning failures using durable retries (platform/test/workerd/thread-layout.workers.ts).
export const DEFAULT_PROVISION_RETRY: RetryOptions<Error> = {
  decide: (failure, attempt) => Effect.succeed(attempt < DEFAULT_PROVISION_RETRY_LIMIT ? { delayMs: DEFAULT_PROVISION_RETRY_INTERVAL_MS, reason: String(failure) } : undefined),
}

export interface ThreadRequest {
  readonly instance: string
  readonly parent?: ThreadCoordinate
  readonly name?: string
  readonly placement?: ChildPlacement
  readonly initialState?: InitialState
}

// Supervisor allocates threads and exposes their durable registration directory within a hosted actor type.
export class Supervisor extends Context.Service<Supervisor, {
  readonly allocate: (request: ThreadRequest) => Effect.Effect<ThreadCoordinate, Error>
  readonly lookup: (coordinate: ThreadCoordinate) => Effect.Effect<ThreadCoordinate | undefined, Error>
  readonly store: (instance: string) => Effect.Effect<SupervisorStore, Error>
}>()("experimental/Supervisor") {}

// createSupervisor manages per-instance directory actors and provisions their requested threads.
export function createSupervisor(options: {
  readonly attemptTimeoutMs?: number | null
  readonly actor: string
  readonly checkpointPolicy?: CheckpointPolicy
  readonly journalReadBatchSize?: number
  readonly promises?: Partial<PromisePolicy>
  readonly canDrive?: (instance: string) => Effect.Effect<boolean, Error>
  readonly journal: (instance: string) => Journal<SupervisorEvent>
  readonly provisionRetry?: RetryOptions<Error>
  readonly provision: (allocation: ThreadAllocation) => Effect.Effect<void, Error>
  readonly initialStateInheritedKeys?: Readonly<Record<string, Schema.Json>>
  readonly initialStateDefaults?: InitialState | undefined
  readonly validateInitialState?: (state: InitialState) => Effect.Effect<void, Error>
  readonly generateName?: () => string
  readonly defaultChildPlacement: ChildPlacement
  readonly supportedChildPlacements: readonly ChildPlacement[]
  readonly run: <Value>(work: Effect.Effect<Value, Error>) => Effect.Effect<Value, Error>
}) {
  if (!options.supportedChildPlacements.includes(options.defaultChildPlacement)) throw new RuntimeError("Default child placement is unsupported")
  const openSupervisor = (instance: string) => Effect.gen(function* () {
    let runtime!: ActorRuntime<SupervisorEvent>
    const journal = options.journal(instance)
    const familyJournal: Journal<SupervisorEvent> = {
      ...journal,
      readCheckpoint: () => {
        const checkpoint = journal.readCheckpoint(SUPERVISOR_CHECKPOINT_TAG)
        return checkpoint?.tag === SUPERVISOR_CHECKPOINT_TAG ? checkpoint : undefined
      },
      appendWithCheckpoint: (position, records, checkpoint, inputs) => journal.appendWithCheckpoint(position, records, { ...checkpoint, tag: SUPERVISOR_CHECKPOINT_TAG }, inputs),
    }
    const store = yield* createActorStore({
      ...(options.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: options.attemptTimeoutMs }),
      actor: familySupervisorActor,
      journalReadBatchSize: options.journalReadBatchSize ?? DEFAULT_SUPERVISOR_JOURNAL_READ_BATCH_SIZE,
      ...(options.checkpointPolicy ? { checkpoint: options.checkpointPolicy } : {}),
      ...(options.canDrive ? { canDrive: options.canDrive(instance) } : {}),
      ...(options.promises ? { promises: options.promises } : {}),
      journal: familyJournal,
      actorContext: () => Context.empty(),
      services: current => {
        runtime = current
        return Provision.layer(allocation => Effect.gen(function* () {
          const execution = yield* EffectExecution
          const reply = durablePromise(execution.ref, { success: Schema.Null, error: Schema.String })
          const handle = yield* execution.fork(execution.retry(options.provision(allocation), options.provisionRetry ?? DEFAULT_PROVISION_RETRY).pipe(
            Effect.match({ onFailure: error => reply.fail(String(error)), onSuccess: () => reply.succeed(null) }),
          ))
          return Provision.defer(handle)
        }).pipe(Effect.mapError(String)))
      },
    })
    return { ...store, send: runtime.send }
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
        supervisor.resume.pipe(Effect.as(supervisor), Effect.onError(() => supervisor.close)),
      ), Effect.onError(() => Effect.sync(() => { supervisors.delete(instance) }))))
      supervisors.set(instance, pending)
    }
    return yield* pending
  })
  const allocate = (request: ThreadRequest) => serialize(`allocate:${request.instance}`, Effect.gen(function* () {
    const { instance, parent, name: suppliedName, placement: requestedPlacement, initialState } = request
    if (initialState !== undefined) {
      if (!options.validateInitialState) return yield* Effect.fail(new RuntimeError("Initial state validation is not configured"))
      yield* options.validateInitialState(initialState)
    }
    const placement = requestedPlacement ?? options.defaultChildPlacement
    if (!options.supportedChildPlacements.includes(placement)) return yield* Effect.fail(new RuntimeError(`Unsupported child placement: ${placement}`))
    if (parent && (parent.actor !== options.actor || parent.instance !== instance)) return yield* Effect.fail(new RuntimeError("Parent belongs to another actor instance"))
    const supervisor = yield* supervisorFor(instance)
    const ancestor = parent ? supervisor.get(threadAtom(parent.thread)) : undefined
    if (parent && ancestor?.status !== "registered") return yield* Effect.fail(new RuntimeError("Unknown parent thread"))
    const name = suppliedName ?? (options.generateName ? yield* Effect.try({ try: options.generateName, catch: RuntimeError.from }) : yield* randomName)
    if (!name || name.includes("/")) return yield* Effect.fail(new RuntimeError("Thread name must be nonempty and contain no slash"))
    const claimed = supervisor.get(threadByName(threadNameKey(parent?.thread ?? null, name)))
    const existing = claimed === undefined ? undefined : supervisor.get(threadAtom(claimed))
    if (claimed !== undefined && !existing) return yield* Effect.fail(new RuntimeError("Named thread has no allocation"))
    if (existing) {
      if (initialState !== undefined && !isDeepStrictEqual(existing.initialState, { ...Object.fromEntries((existing.initialStateDefaultKeys ?? []).filter(key => Object.hasOwn(existing.initialState ?? {}, key)).map(key => [key, existing.initialState![key]])), ...initialState })) return yield* Effect.fail(new RuntimeError("Named thread already has different initial state"))
      if (requestedPlacement !== undefined && existing.placement !== requestedPlacement) return yield* Effect.fail(new RuntimeError("Named thread already has different placement"))
      if (suppliedName === undefined) return yield* Effect.fail(new RuntimeError("Generated thread name already exists; supply a different name or generator"))
      if (existing.status === "failed") {
        const { coordinate, name, parent, depth, placement, initialState, initialStateDefaultKeys } = existing
        yield* supervisor.send([{ type: "ThreadRequested", allocation: { coordinate, name, parent, depth, placement, ...(initialState === undefined ? {} : { initialState }), ...(initialStateDefaultKeys === undefined ? {} : { initialStateDefaultKeys }) } }])
      } else yield* supervisor.resume
      return { supervisor, coordinate: existing.coordinate }
    }
    const thread = supervisor.get(threadAtom(name)) ? `${name}-${yield* randomName}` : name
    if (supervisor.get(threadAtom(thread))) return yield* Effect.fail(new RuntimeError("Thread identity collision"))
    const coordinate = { actor: options.actor, instance, thread }
    // initialStateInheritedKeys selects recorded ancestor seeds before explicit child overrides (host-initial-state.test.ts).
    const parentInitialState = ancestor?.status === "registered" ? ancestor.initialState : undefined
    const inherited = ancestor && options.initialStateInheritedKeys ? Object.fromEntries(Object.entries(options.initialStateInheritedKeys)
      .filter(([key]) => Object.hasOwn(parentInitialState ?? {}, key) || Object.hasOwn(options.initialStateDefaults ?? {}, key))
      .map(([key, fallback]) => [key, Object.hasOwn(parentInitialState ?? {}, key) ? parentInitialState![key]! : fallback])) : {}
    const defaults = Object.keys(inherited).length ? { ...options.initialStateDefaults, ...inherited } : options.initialStateDefaults
    const seeded = defaults === undefined ? initialState : { ...defaults, ...initialState }
    if (seeded !== undefined && seeded !== initialState) {
      if (!options.validateInitialState) return yield* Effect.fail(new RuntimeError("Initial state validation is not configured"))
      yield* options.validateInitialState(seeded)
    }
    yield* supervisor.send([{ type: "ThreadRequested", allocation: { coordinate, name, parent: parent?.thread ?? null, depth: ancestor ? ancestor.depth + 1 : 0, placement, ...(seeded === undefined ? {} : { initialState: seeded }), ...(defaults === undefined ? {} : { initialStateDefaultKeys: Object.keys(defaults).filter(key => !Object.hasOwn(initialState ?? {}, key)) }) } }])
    return { supervisor, coordinate }
  })).pipe(Effect.flatMap(({ supervisor, coordinate }) => Effect.gen(function* () {
    const registered = Deferred.makeUnsafe<void, Error>()
    const check = () => {
      const allocated = supervisor.get(threadAtom(coordinate.thread))
      if (allocated?.status === "registered") Deferred.doneUnsafe(registered, Effect.void)
      else if (allocated?.status === "failed") Deferred.doneUnsafe(registered, Effect.fail(new RuntimeError(allocated.reason ?? "Thread provisioning did not complete")))
    }
    yield* Effect.acquireUseRelease(
      Effect.sync(() => { const stop = supervisor.subscribe(check); check(); return stop }),
      () => Effect.raceFirst(Deferred.await(registered), supervisor.wait.pipe(Effect.andThen(Effect.suspend(() => {
        check()
        return Deferred.isDoneUnsafe(registered) ? Deferred.await(registered) : Effect.fail(new RuntimeError("Thread provisioning did not complete"))
      })))),
      stop => Effect.sync(stop),
    )
    return Object.freeze({ ...coordinate })
  })))
  const lookup = (coordinate: ThreadCoordinate) => Effect.gen(function* () {
    if (coordinate.actor !== options.actor) return yield* Effect.fail(new RuntimeError(`Unknown actor: ${coordinate.actor}`))
    const supervisor = yield* supervisorFor(coordinate.instance)
    const entry = supervisor.get(threadAtom(coordinate.thread))
    return entry?.status === "registered" ? Object.freeze({ ...entry.coordinate }) : undefined
  })
  return {
    allocate: (request: ThreadRequest) => options.run(Effect.try({ try: () => structuredClone(request), catch: RuntimeError.from }).pipe(Effect.flatMap(allocate))),
    lookup: (coordinate: ThreadCoordinate) => options.run(lookup(coordinate)),
    store: (instance: string) => options.run(supervisorFor(instance).pipe(Effect.map(createSupervisorStore))),
    recover: (instance: string) => options.run(Effect.gen(function* () {
      const supervisor = yield* supervisorFor(instance)
      yield* supervisor.resume
      yield* supervisor.wait
      return supervisor.recoveryState()
    })),
    invalidate: (instance: string) => options.run(Effect.gen(function* () {
      const pending = supervisors.get(instance)
      supervisors.delete(instance)
      if (pending) yield* pending.pipe(Effect.flatMap(store => store.close), Effect.ignore)
    })),
    close: Effect.gen(function* () {
      const results = yield* Effect.forEach(supervisors.values(), pending =>
        Effect.exit(Effect.gen(function* () { const supervisor = yield* pending; yield* supervisor.close })),
      )
      const failure = results.find(Exit.isFailure)
      if (failure && Exit.isFailure(failure)) return yield* Effect.failCause(failure.cause)
    }),
  } satisfies typeof Supervisor.Service & { readonly close: Effect.Effect<void, Error>; readonly recover: (instance: string) => Effect.Effect<RecoveryState, Error>; readonly invalidate: (instance: string) => Effect.Effect<void, Error> }
}
