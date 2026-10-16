import { treeSession, resolveInput } from "../services/tree-state"
import type { ReadonlyIndex } from "./log-view"
import { initialStateSeed, type StateSeed } from "../initialise"
import { ActorCommitError, AttemptTimedOut, RuntimeError, PromiseNotReady, PromiseTimedOut, ExecutionResult, EffectCancelled, CancellationOutcome, effectKey, type EffectRef } from "./effects"
import { createStore } from "../atoms/store"
import { createRecordSource } from "./event-source"
import { atom, type Atom } from "../atoms/atom"
import { EventLog, ReplayContext, executionDefect } from "../services/event-log"
import { Scheduler } from "../services/scheduler"
import { operationSettlement, cleanupRunnable, cleanupSucceeded } from "./operation"
import { EffectExecution, DEFAULT_ATTEMPT_TIMEOUT_MS, type AttemptOptions, type RetryOptions } from "../services/effect-execution"
import { createExecutionStream, type ExecutionStream, type ExecutionStreamPolicy } from "../services/execution-stream"
import { EffectRequested, EffectSettled, EffectDied, PromiseSettled, hasCoreEventType, type RetryScheduled } from "./events"
import { cancelAct, type ActCancellation } from "../atoms/act"
import type { RuntimeEvent, JournalEvent, Journal, MessageJournal, RecordMetadata, Recorded, EffectInputChanges } from "../services/journal"
import type { ActorRuntime, ActorSetup, Requirements } from "./contracts"
import type { ActorDefinition } from "../actor/definition"
import { type MessageMetadata as DeliveryMetadata, type MessageReceipt, MessageAddress, MessageDelivered, MessageMetadata, MessageConflict, InvalidMessage, isMessageReceived } from "../actor/message"
import type { ThreadCoordinate } from "../actor/thread"
import { MethodInvocation, MethodCancellation, type ActorMethods } from "../actor/method"
import { createEventLog, retireCheckpoint, type EffectCheckpoint } from "./replay"
import { isDeepStrictEqual } from "node:util"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Cause, Schema, Option, Queue, Schedule, Clock, Random } from "effect"
import { WatchdogTerminalError, type RecoveryState } from "../services/watchdog"
import { Promises, DEFAULT_PROMISE_POLICY, promiseDeadline, promisePolicy, type PromisePolicy } from "../services/promises"
import type { Options as JsonTreeOptions } from "@tardie/grove"
import { checkpointEncoder, DEFAULT_CHECKPOINT_MAX_BYTES, checkpointDigest, decodeCheckpoint, encodeCheckpoint } from "../services/checkpoint"
import { observeRequest, DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES } from "./input-digest"
import { messageReplies } from "./messages"
import { DeliverMessage, type MessageDelivery } from "../services/invocation"
import { select } from "./stores/thread"

export interface CancellationOptions extends AttemptOptions {
  // retryIntervalMs sets the default delay when decide is omitted.
  readonly retryIntervalMs?: number
  // decide returns undefined to record a final typed cleanup failure.
  readonly decide?: RetryOptions<Error>["decide"]
}

export type CheckpointPolicy =
  | { readonly mode: "threshold"; readonly options: { readonly everyEvents: number; readonly maxBytes?: number; readonly tree?: JsonTreeOptions } }
  | { readonly mode: "manual"; readonly options?: { readonly maxBytes?: number; readonly tree?: JsonTreeOptions } }

export const DEFAULT_MESSAGE_RETRY_INTERVAL_MS = 5_000

export interface DeliveryOptions {
  readonly address: ThreadCoordinate
  readonly send: (message: MessageDelivery) => Effect.Effect<MessageReceipt, Error>
  readonly retryIntervalMs?: number
}

export const DEFAULT_CANCELLATION_RETRY_INTERVAL_MS = 5_000

export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = { mode: "threshold", options: { everyEvents: 500 } }

export type ActorServices<Definition> = Definition extends ActorDefinition<infer Event, infer State, infer Services>
  ? (runtime: ActorRuntime<Event>) => Layer.Layer<Requirements<{ root: Atom<State> }> | Exclude<Services, Scope.Scope>, Error>
  : never

// createActorStore instantiates an actor definition and owns its services, journal commits, and execution lifetime.
export function createActorStore<Event extends object, State, Services, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: {
  readonly attemptTimeoutMs?: number | null
  readonly executionStream?: Partial<ExecutionStreamPolicy>
  readonly executionStreamBus?: typeof ExecutionStream.Service
  // inspect validates setup without executing proposals or recovery hooks (packages/platform/test/bun/method-http.test.ts).
  readonly inspect?: boolean
  readonly canDrive?: Effect.Effect<boolean, Error>
  readonly actor: ActorDefinition<Event, State, Services, Contracts>
  readonly services: (runtime: ActorRuntime<Event>) => Layer.Layer<Requirements<{ root: Atom<State> }> | Exclude<Services, Scope.Scope>, Error>
  // actorContext selects setup capabilities explicitly; the execution context is supplied only to effect execution.
  readonly actorContext: (services: Context.Context<Requirements<{ root: Atom<NoInfer<State>> }> | Exclude<NoInfer<Services>, Scope.Scope>>) => Context.Context<Exclude<NoInfer<Services>, Scope.Scope>>
  readonly events?: readonly RuntimeEvent<Event>[]
  readonly effectInput?: { readonly digestMinBytes?: number }
  readonly checkpoint?: CheckpointPolicy
  readonly cancellation?: CancellationOptions
  readonly promiseDelivery?: { readonly retryIntervalMs?: number }
  readonly promises?: Partial<PromisePolicy>
  readonly journal?: Journal<Event> | MessageJournal<Event>
  readonly delivery?: DeliveryOptions
  readonly onEvent?: (event: RuntimeEvent<Event>) => void
}) {
  return Effect.gen(function* () {
    let root!: Atom<State>
    let contracts!: Contracts
    const store = yield* createRuntime<Event, Readonly<Record<string, Atom<State>>>, Services, Contracts>({
      ...options,
      setup: options.actor.setup.pipe(Effect.map(setup => {
        root = setup.root
        contracts = setup.contracts
        return setup
      })),
    })
    const state = select(store, root)
    return { ...store, getState: state.get, subscribe: state.subscribe, contracts }
  })
}

// createRuntime builds services and an atom graph within an isolated actor lifetime.
function createRuntime<Event extends object, const Atoms extends Readonly<Record<string, Atom<unknown>>>, Services, Contracts extends ActorMethods<Event>>(options: {
  readonly attemptTimeoutMs?: number | null
  readonly executionStream?: Partial<ExecutionStreamPolicy>
  readonly executionStreamBus?: typeof ExecutionStream.Service
  readonly inspect?: boolean
  readonly canDrive?: Effect.Effect<boolean, Error>
  readonly setup: Effect.Effect<ActorSetup<Event, Atoms, Contracts>, Error, Services>
  readonly services: (runtime: ActorRuntime<Event>) => Layer.Layer<Requirements<Atoms> | Exclude<Services, Scope.Scope>, Error>
  readonly actorContext: (services: Context.Context<Requirements<Atoms> | Exclude<Services, Scope.Scope>>) => Context.Context<Exclude<Services, Scope.Scope>>
  readonly events?: readonly RuntimeEvent<Event>[]
  readonly effectInput?: { readonly digestMinBytes?: number }
  readonly checkpoint?: CheckpointPolicy
  readonly cancellation?: CancellationOptions
  readonly promiseDelivery?: { readonly retryIntervalMs?: number }
  readonly promises?: Partial<PromisePolicy>
  readonly journal?: Journal<Event> | MessageJournal<Event>
  readonly delivery?: DeliveryOptions
  readonly onEvent?: (event: RuntimeEvent<Event>) => void
}) {
  return Effect.gen(function* () {
    if (options.journal && options.events !== undefined) return yield* Effect.fail(new RuntimeError("Supply either a journal or initial events"))
    const digestMinBytes = options.effectInput?.digestMinBytes ?? DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES
    if (!Number.isSafeInteger(digestMinBytes) || digestMinBytes < 0) return yield* Effect.fail(new RuntimeError("Effect input digest minBytes must be a nonnegative safe integer"))
    const resolutionPolicy = yield* Effect.try({ try: () => promisePolicy(options.promises), catch: RuntimeError.from })
    const executionAttemptTimeoutMs = options.attemptTimeoutMs
    if (executionAttemptTimeoutMs !== undefined && executionAttemptTimeoutMs !== null && (!Number.isSafeInteger(executionAttemptTimeoutMs) || executionAttemptTimeoutMs < 1)) return yield* Effect.fail(new RuntimeError("Attempt timeoutMs must be a positive safe integer"))
    const deliveryRetryIntervalMs = options.promiseDelivery?.retryIntervalMs ?? DEFAULT_PROMISE_POLICY.retryIntervalMs
    if (!Number.isSafeInteger(deliveryRetryIntervalMs) || deliveryRetryIntervalMs < 1) return yield* Effect.fail(new RuntimeError("Promise delivery retryIntervalMs must be a positive safe integer"))
    let setup: ActorSetup<Event, Atoms, Contracts>
    type RuntimeAtoms = Atoms & { readonly "host.message.replies": ReturnType<typeof messageReplies<Event>> }
    let definition: ReturnType<typeof createEventLog<Event, RuntimeAtoms>>
    let snapshot: ReturnType<typeof definition.replay>
    const localRecovery = new Map<string, ReturnType<typeof snapshot.deferred>[number]>()
    const trees = options.journal?.trees ? treeSession(options.journal.trees) : options.journal ? undefined : treeSession({ load: () => { throw new RuntimeError("In-memory execution cannot load unstaged tree nodes") } })
    const resolve = (request: Parameters<typeof resolveInput>[0]) => resolveInput(request, trees ? ref => trees.readReference(ref) : undefined)
    const source = createRecordSource<Event>()
    const bindings = atom<ReadonlyIndex<object, EffectRef>>(new Map())
    let checkpointSeed: EffectCheckpoint | undefined
    let initialState: StateSeed | undefined
    let checkpointPosition = 0
    const checkpointPolicy = options.checkpoint ?? DEFAULT_CHECKPOINT_POLICY
    if (checkpointPolicy.mode !== "threshold" && checkpointPolicy.mode !== "manual") return yield* Effect.fail(new RuntimeError("Checkpoint mode must be threshold or manual"))
    if (checkpointPolicy.mode === "threshold" && (!Number.isSafeInteger(checkpointPolicy.options.everyEvents) || checkpointPolicy.options.everyEvents < 1)) return yield* Effect.fail(new RuntimeError("Checkpoint everyEvents must be a positive safe integer"))
    const checkpointMaxBytes = checkpointPolicy.options?.maxBytes ?? DEFAULT_CHECKPOINT_MAX_BYTES
    if (!Number.isSafeInteger(checkpointMaxBytes) || checkpointMaxBytes < 1) return yield* Effect.fail(new RuntimeError("Checkpoint maxBytes must be a positive safe integer"))
    const encodeTree = checkpointEncoder(checkpointPolicy.options?.tree)
    const persistCheckpoint = (position: number, records: readonly Recorded<Event>[], checkpoint: EffectCheckpoint, inputs?: EffectInputChanges) => Effect.gen(function* () {
      const journal = options.journal!
      const staged = inputs?.trees ?? (trees ? { nodes: trees.nodes(), roots: checkpoint.durable.flatMap(entry => entry.tree ? [{ name: entry.name, root: entry.tree }] : []), held: trees.held() } : undefined)
      const changes = { ...inputs, ...(staged ? { trees: staged } : {}) }
      const referencedBytes = yield* Effect.try({ try: () => checkpoint.durable.reduce((bytes, entry) => bytes + (entry.tree ? trees!.bytes(entry.tree) : 0), 0), catch: RuntimeError.from })
      if (journal.treeCheckpoint) {
        const payload = yield* Effect.try({ try: () => encodeTree(checkpoint), catch: RuntimeError.from })
        if (payload.logicalBytes + referencedBytes > checkpointMaxBytes) return yield* Effect.fail(new RuntimeError(`Checkpoint exceeds maxBytes ${checkpointMaxBytes}`))
        yield* journal.treeCheckpoint.append(position, records, { position: checkpoint.position, payload, digest: payload.root, roots: checkpoint.durable.flatMap(entry => entry.tree ? [{ name: entry.name, root: entry.tree }] : []) }, changes)
      } else {
        const payload = yield* Effect.try({ try: () => encodeCheckpoint(checkpoint), catch: RuntimeError.from })
        if (payload.byteLength + referencedBytes > checkpointMaxBytes) return yield* Effect.fail(new RuntimeError(`Checkpoint exceeds maxBytes ${checkpointMaxBytes}`))
        const digest = yield* checkpointDigest(payload)
        yield* journal.appendWithCheckpoint(position, records, { position: checkpoint.position, payload, digest }, changes)
      }
      if (staged) trees!.committed(staged.nodes)
    })
    const projectionContext: typeof EventLog.Service = {
      ...(trees ? { trees } : {}),
      events: source.observedEvents,
      records: source.observedRecords,
      bindings,
      position: () => checkpointSeed?.position ?? 0,
      initialState: () => initialState ??= initialStateSeed(store.get(source.records), checkpointSeed),
      effect: ref => {
        const state = snapshot?.effect(ref)
        return state ? { ...state, request: Object.freeze(observeRequest(state.request)) } : undefined
      },
      defect: () => snapshot?.defect,
      promise: ref => snapshot?.promise(ref),
    }
    const store = createStore(Context.make(EventLog, projectionContext))
    const sync = () => {
      const position = store.get(source.records).length
      if (position > snapshot.events.length) throw new RuntimeError("Committed event history cannot shrink")
      store.set(bindings, snapshot.bindings)
      source.append(store, snapshot.records.slice(position))
    }
    const recovery: Effect.Effect<void, Error>[] = []
    const committed: Effect.Effect<void, Error>[] = []
    const ready = Deferred.makeUnsafe<void>()
    const scope = yield* Scope.make()
    const executionStream = options.executionStreamBus ?? (yield* createExecutionStream(options.executionStream))
    const retryWaits = new Map<string, { readonly dueAt: number; readonly wake: Deferred.Deferred<void> }>()
    const lifetimes = new Map<string, { readonly scope: Scope.Closeable; readonly signal: AbortSignal }>()
    const executions = new Map<string, Fiber.Fiber<{ readonly status: "fulfilled"; readonly value: ExecutionResult } | { readonly status: "rejected"; readonly reason: Schema.Json }, never>>()
    const completing = new Map<string, Deferred.Deferred<void>>()
    const executionWaiters = new Set<Deferred.Deferred<void>>()
    const persistedInputRefs = new Map<string, EffectRef>()
    const cleanupWork = () => snapshot.cancelled().filter(work => cleanupRunnable(snapshot.effect(work.ref)))
    const cleaning = new Set<string>()
    const pendingCleanup = new Set<string>()
    const reportCleanup = (outcome: CancellationOutcome) => {
      if (outcome.type === "CancellationDied") report(new WatchdogTerminalError(outcome.diagnostic))
      else if (outcome.outcome.status === "rejected") report(new WatchdogTerminalError(outcome.outcome.reason))
    }
    const queueCleanup = (cancellation: ActCancellation) => {
      const key = effectKey(cancellation.ref)
      const outcome = snapshot.effect(cancellation.ref)?.cleanup?.outcome
      if (outcome) { reportCleanup(outcome); return }
      if (!cleaning.has(key)) pendingCleanup.add(key)
    }
    const cancellationRetryIntervalMs = options.cancellation?.retryIntervalMs ?? DEFAULT_CANCELLATION_RETRY_INTERVAL_MS
    if (!Number.isSafeInteger(cancellationRetryIntervalMs) || cancellationRetryIntervalMs < 1) return yield* Effect.fail(new RuntimeError("Cancellation retryIntervalMs must be a positive safe integer"))
    const background = new Map<string, Fiber.Fiber<void, never>>()
    const deadlineTimers = new Map<string, Fiber.Fiber<void, never>>()
    const errors: Error[] = []
    const runtimeFailure = (deferTerminal = false): Error | undefined => {
      const cleanup = deferTerminal && cleanupWork().length > 0
      const defect = store.get(executionDefect)
      return persistenceFailure ?? errors.find(error => !cleanup || !(error instanceof WatchdogTerminalError)) ??
        (defect && !cleanup ? new WatchdogTerminalError(defect.diagnostic) : undefined)
    }
    const subscriptions = new Set<() => void>()
    let closed = false
    let persistenceFailure: ActorCommitError | undefined
    const admissions = yield* Queue.make<Effect.Effect<void>>()
    const processing = yield* Queue.make<Deferred.Deferred<void>>()
    const notifications = yield* Queue.make<readonly RuntimeEvent<Event>[]>()
    let scheduled: Deferred.Deferred<void> | undefined
    const report = (error: unknown) => { if (!closed) errors.push(error instanceof WatchdogTerminalError ? error : RuntimeError.from(error)) }
    const reportCause = (cause: Cause.Cause<unknown>) => Effect.sync(() => {
      if (!Cause.hasInterruptsOnly(cause)) report(Cause.hasDies(cause) ? new WatchdogTerminalError(Cause.pretty(cause)) : new RuntimeError(Cause.pretty(cause)))
    })
    const schedule = Effect.gen(function* () {
      if (closed) return
      const completion = yield* Deferred.make<void>()
      scheduled = completion
      yield* Queue.offer(processing, completion)
    })
    const commit = (next: typeof snapshot) => Effect.gen(function* () {
      if (persistenceFailure) return yield* persistenceFailure
      if (next === snapshot) return
      const records = next.records.slice(snapshot.records.length)
      const eligible = checkpointPolicy.mode === "threshold" && next.position - checkpointPosition >= checkpointPolicy.options.everyEvents
      const checkpoint = options.journal && eligible ? next.checkpoint() : undefined
      if (options.journal) {
        const journal = options.journal
        const put = records.flatMap(({ event }) => Schema.is(EffectRequested)(event)
          ? next.pending().filter(work => effectKey(work.ref) === effectKey(event.ref)).map(({ ref, request }) => ({ ref, request })) : [])
        const roots = next.treeRoots()
        const held = trees?.held() ?? []
        const treeChanges = trees ? { nodes: trees.nodes([...roots.map(entry => entry.root), ...held, ...put.flatMap(({ request }) => request.selections?.map(ref => ref.root) ?? []), ...(checkpoint?.durable.flatMap(entry => entry.tree ? [entry.tree] : []) ?? [])]), roots, held } : undefined
        const inputChanges = {
          ...(treeChanges ? { trees: treeChanges } : {}),
          put,
          remove: records.flatMap(({ event }) => {
            if (Schema.is(EffectDied)(event)) return next.cancelled().length ? [] : [...persistedInputRefs.values()].filter(ref => ref.atom !== "host.message.replies")
            if (Schema.is(CancellationOutcome)(event) && cleanupSucceeded(event)) return next.defect && !next.cancelled().length
              ? [...persistedInputRefs.values()].filter(ref => ref.atom !== "host.message.replies") : [event.ref]
            if (!Schema.is(PromiseSettled)(event) && !Schema.is(EffectSettled)(event)) return []
            if (next.effect(event.ref)?.cleanup?.request) return []
            if (Schema.is(EffectSettled)(event) && event.outcome.status === "fulfilled" && Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value).type === "promise") return []
            return [event.ref]
          }),
        }
        const persistence = checkpoint
          ? persistCheckpoint(snapshot.position, records, checkpoint, inputChanges)
          : journal.append(snapshot.position, records, inputChanges)
        yield* persistence.pipe(Effect.catchCause(cause => Effect.gen(function* () {
          const operation = checkpoint ? "checkpoint" as const : "append" as const
          yield* Effect.logError("Actor journal commit failed").pipe(Effect.annotateLogs({
            operation,
            position: snapshot.position,
            cause: Cause.pretty(cause),
          }))
          definition.discard(next)
          persistenceFailure = new ActorCommitError({
            message: "Actor state could not be persisted; recreate the actor store before retrying",
            position: snapshot.position,
            operation,
            cause,
          })
          return yield* persistenceFailure
        })))
        if (treeChanges) trees!.committed(treeChanges.nodes)
        for (const input of inputChanges.put) persistedInputRefs.set(effectKey(input.ref), input.ref)
        for (const ref of inputChanges.remove) persistedInputRefs.delete(effectKey(ref))
      }
      if (options.journal && checkpoint) checkpointPosition = next.position
      snapshot = next
      for (const { event: record } of records) {
        if (Schema.is(EffectDied)(record)) {
          yield* Fiber.interruptAll([...executions.values(), ...[...background].filter(([id]) => !id.startsWith("cancellation:")).map(([, fiber]) => fiber), ...deadlineTimers.values()]).pipe(Effect.forkIn(scope))
          for (const lifetime of lifetimes.values()) yield* Scope.close(lifetime.scope, Exit.succeed(undefined))
          lifetimes.clear()
          continue
        }
        if (Schema.is(PromiseSettled)(record)) {
          const key = effectKey(record.ref)
          const lifetime = lifetimes.get(key)
          if (lifetime) yield* Scope.close(lifetime.scope, Exit.succeed(undefined))
          lifetimes.delete(key)
          const timer = deadlineTimers.get(key)
          if (timer && !(record.result.status === "rejected" && Schema.is(PromiseTimedOut)(record.result.reason))) yield* Fiber.interrupt(timer).pipe(Effect.forkIn(scope))
          const pending = background.get(key)
          if (pending) yield* Fiber.interrupt(pending).pipe(Effect.forkIn(scope))
          continue
        }
        if (!Schema.is(EffectCancelled)(record) && !Schema.is(EffectSettled)(record)) continue
        const lifecycle = next.effect(record.ref)
        const cancellation = lifecycle?.cleanup?.request
        if (!cancellation) continue
        const cleanup = next.cancelled().find(work => effectKey(work.ref) === effectKey(record.ref))
        if (!cleanup) {
          if (lifecycle?.cleanup?.outcome) continue
          return yield* Effect.fail(new RuntimeError("Cancellation requires reconstructed input"))
        }
        queueCleanup(cleanup)
        const key = effectKey(cancellation.ref)
        const timer = deadlineTimers.get(key)
        if (timer) yield* Fiber.interrupt(timer).pipe(Effect.forkIn(scope))
        const lifetime = lifetimes.get(key)
        if (lifetime) yield* Scope.close(lifetime.scope, Exit.succeed(undefined))
        lifetimes.delete(key)
        const executing = executions.get(key)
        const deferred = background.get(key)
        const retry = retryWaits.get(key)
        if (retry) yield* Deferred.succeed(retry.wake, undefined)
        if (executing) yield* Fiber.interrupt(executing).pipe(Effect.forkIn(scope))
        if (deferred) yield* Fiber.interrupt(deferred).pipe(Effect.forkIn(scope))
      }
      yield* Effect.try({ try: sync, catch: RuntimeError.from }).pipe(Effect.catch(error => Effect.sync(() => report(error))))
      yield* Queue.offer(notifications, next.events.slice(next.events.length - records.length))
      yield* cleanCancellations.pipe(Effect.catchCause(reportCause))
      yield* schedule
    })
    const enqueue = <Value>(work: Effect.Effect<Value, Error>) => Effect.gen(function* () {
      if (options.inspect) return yield* Effect.fail(new RuntimeError("Actor inspection cannot admit work"))
      if (closed) return yield* Effect.fail(new RuntimeError("Actor store is closed"))
      const accepted = yield* Deferred.make<Value, Error>()
      yield* Queue.offer(admissions, Effect.gen(function* () {
        const outcome = yield* Effect.exit(work)
        yield* Deferred.done(accepted, outcome)
      }).pipe(Effect.uninterruptible))
      return yield* Deferred.await(accepted)
    })
    const appendNow = (event: JournalEvent<Event>, metadata: Omit<RecordMetadata, "recordedAt"> = {}): Effect.Effect<void, Error> => Effect.gen(function* () {
      const recordedAt = yield* Clock.currentTimeMillis
      const updated = yield* Effect.try({ try: () => {
        let next = definition.append(snapshot, event, { ...metadata, recordedAt })
        if (next === snapshot) return next
        try {
          for (const domain of next.followups(event)) {
            if (hasCoreEventType(domain) && !Schema.is(MessageDelivered)(domain)) throw new RuntimeError("Act callbacks must return domain events")
            next = definition.append(next, domain as Event, { recordedAt })
          }
          return next
        } catch (error) {
          definition.discard(next)
          throw error
        }
      }, catch: RuntimeError.from })
      yield* commit(updated)
      for (const cancellation of snapshot.cancellations()) yield* appendNow(cancellation)
    })
    const append = (event: RuntimeEvent<Event>) => enqueue(appendNow(event))
    const recordDeath = (ref: EffectRef, cause: Cause.Cause<unknown>) => enqueue(Effect.suspend(() =>
      snapshot.defect || snapshot.promise(ref) || snapshot.effect(ref)?.cleanup?.request ? Effect.void
        : appendNow({ type: "EffectDied", ref, diagnostic: Cause.pretty(cause) }),
    ))
    const promiseTimeouts = new Map<string, number>()
    const normalizePromise = (ref: EffectRef, value: ExecutionResult) => Effect.gen(function* () {
      if (value.type !== "promise") return value
      const prior = operationSettlement(snapshot.effect(ref))?.outcome
      const recorded = prior?.status === "fulfilled" ? yield* Schema.decodeUnknownEffect(ExecutionResult)(prior.value).pipe(Effect.mapError(RuntimeError.from)) : undefined
      const startedAt = yield* Clock.currentTimeMillis
      const timeoutMs = promiseTimeouts.get(effectKey(ref)) ?? resolutionPolicy.timeoutMs
      const deadlineAt = promiseDeadline(value.handle, startedAt, { ...resolutionPolicy, timeoutMs }, recorded?.type === "promise" ? recorded.deadlineAt : undefined)
      promiseTimeouts.delete(effectKey(ref))
      return { ...value, deadlineAt }
    })
    let services: Effect.Success<ReturnType<typeof buildServices>>
    const messageRetryIntervalMs = options.delivery?.retryIntervalMs ?? DEFAULT_MESSAGE_RETRY_INTERVAL_MS
    if (!Number.isSafeInteger(messageRetryIntervalMs) || messageRetryIntervalMs < 1) return yield* Effect.fail(new RuntimeError("Delivery retryIntervalMs must be a positive safe integer"))
    const deliveryLayer = DeliverMessage.layer(message => options.delivery
      ? options.delivery.send(message).pipe(Effect.retry(Schedule.spaced(messageRetryIntervalMs)), Effect.mapError(String))
      : Effect.fail("Message delivery is unavailable"))
    function buildServices() {
      return Layer.build(Layer.fresh(Layer.merge(options.services(runtime), deliveryLayer))).pipe(Effect.provideService(Scope.Scope, scope))
    }
    const dispatched = new Set<string>()
    const watched = new Set<string>()
    // observedThrough advances past processed records while failed registrations remain retryable (packages/platform/test/properties/runtime/deferred-recovery.ts, externalProducerObservation).
    let observedThrough = 0
    let lastObserved: RuntimeEvent<Event> | undefined
    const observePromises = Effect.gen(function* () {
      if (store.get(executionDefect)) return
      const observer = Context.getOption(services, Promises)
      const events = snapshot.events
      if (observedThrough > events.length || (observedThrough > 0 && events.at(observedThrough - 1) !== lastObserved)) observedThrough = 0
      for (; observedThrough < events.length; observedThrough++, lastObserved = events.at(observedThrough - 1)) {
        const record = events.at(observedThrough)!
        if (!Schema.is(EffectSettled)(record) || record.outcome.status !== "fulfilled") continue
        const result = yield* Schema.decodeUnknownEffect(ExecutionResult)(record.outcome.value).pipe(Effect.mapError(RuntimeError.from))
        if (result.type !== "promise" || snapshot.promise(record.ref) || snapshot.effect(record.ref)?.cleanup?.request) continue
        const key = effectKey(record.ref)
        if (watched.has(key)) continue
        const deadlineAt = promiseDeadline(result.handle, (yield* Clock.currentTimeMillis), resolutionPolicy, result.deadlineAt)
        if (result.handle.executor === "local") {
          if (!deadlineTimers.has(key)) {
            const timer = yield* Effect.gen(function* () {
              let remaining = deadlineAt - (yield* Clock.currentTimeMillis)
              while (remaining > 0) {
                yield* Effect.sleep(Math.min(remaining, 2_147_483_647))
                remaining = deadlineAt - (yield* Clock.currentTimeMillis)
              }
              yield* append({ type: "PromiseSettled", ref: record.ref, result: { status: "rejected", reason: { _tag: "PromiseTimedOut", deadlineAt } } })
            }).pipe(Effect.catchCause(reportCause), Effect.ensuring(Effect.sync(() => { deadlineTimers.delete(key) })), Effect.forkIn(scope))
            deadlineTimers.set(key, timer)
          }
          watched.add(key)
          continue
        }
        if (Option.isNone(observer)) return yield* Effect.fail(new RuntimeError("Promise execution results require a Promises service"))
        yield* observer.value.watch({ ref: record.ref, handle: result.handle, deadlineAt })
        watched.add(key)
      }
    })
    const waitForRetry = (ref: EffectRef, phase: "execution" | "cancellation", dueAt: number) => Effect.gen(function* () {
      const key = phase === "execution" ? effectKey(ref) : `cancellation:${effectKey(ref)}`
      const waiting = { dueAt, wake: Deferred.makeUnsafe<void>() }
      retryWaits.set(key, waiting)
      yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (dueAt > now) yield* Option.isSome(Context.getOption(services, Scheduler)) ? Deferred.await(waiting.wake) : Effect.raceFirst(Deferred.await(waiting.wake), Effect.sleep(dueAt - now))
      }).pipe(Effect.ensuring(Effect.sync(() => { retryWaits.delete(key) })))
    })
    const cleanCancellations = Effect.gen(function* () {
      for (const key of pendingCleanup) {
        pendingCleanup.delete(key)
        if (cleaning.has(key)) continue
        cleaning.add(key)
        const cleanup = Effect.gen(function* () {
          const ref = snapshot.cancelled().find(work => effectKey(work.ref) === key)?.ref
          if (!ref) return
          const observer = Context.getOption(services, Promises)
          const operation = Effect.gen(function* () {
            const completion = completing.get(key)
            if (completion) yield* Deferred.await(completion)
            const producer = background.get(key)
            if (producer) yield* Fiber.interrupt(producer)
            const current = snapshot.cancelled().find(work => effectKey(work.ref) === key)
            if (!current) return
            if (current.handle && current.handle.executor !== "local" && Option.isSome(observer)) {
              const settlement = operationSettlement(snapshot.effect(current.ref))?.outcome
              const value = settlement?.status === "fulfilled" ? yield* Schema.decodeUnknownEffect(ExecutionResult)(settlement.value).pipe(Effect.mapError(RuntimeError.from)) : undefined
              yield* observer.value.cancel({ ref: current.ref, handle: current.handle, ...(value?.type === "promise" && value.deadlineAt !== undefined ? { deadlineAt: value.deadlineAt } : {}) })
            }
            const request = current.request.selections?.length ? { ...current.request, input: yield* Effect.try({ try: () => resolve(current.request), catch: RuntimeError.from }) } : current.request
            yield* cancelAct({ ...current, request }, { get: store.get, cancel: runtime.cancel }).pipe(Effect.provide(services))
          })
          const result = yield* Effect.exit(retryOperation(operation, {
            attemptTimeoutMs: options.cancellation?.attemptTimeoutMs === undefined ? executionAttemptTimeoutMs : options.cancellation.attemptTimeoutMs,
            decide: options.cancellation?.decide ?? (error => Effect.succeed({ delayMs: cancellationRetryIntervalMs, reason: error.message })),
          }, {
            previous: snapshot.retry(ref, "cancellation"), beforeAttempt: Effect.suspend(() => closed ? Effect.interrupt : Effect.void),
            wait: dueAt => waitForRetry(ref, "cancellation", dueAt),
            record: (attempt, dueAt, reason) => append({ type: "RetryScheduled", phase: "cancellation", ref, attempt, dueAt, reason }),
          }))
          if (persistenceFailure) return yield* persistenceFailure
          if (Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)) return yield* Effect.failCause(result.cause)
          const outcome: CancellationOutcome = Exit.isSuccess(result)
            ? { type: "CancellationSettled", ref, outcome: { status: "fulfilled" } }
            : Cause.hasDies(result.cause)
              ? { type: "CancellationDied", ref, diagnostic: Cause.pretty(result.cause) }
              : { type: "CancellationSettled", ref, outcome: { status: "rejected", reason: RuntimeError.from(Cause.squash(result.cause)).message } }
          yield* append(outcome)
          reportCleanup(outcome)
        })
        yield* runtime.fork(`cancellation:${key}`, cleanup)
      }
    })
    const afterCommit = () => Effect.gen(function* () {
      while (true) {
        const batch = yield* Queue.poll(notifications)
        if (Option.isNone(batch)) break
        for (const record of batch.value) {
          yield* Effect.try({ try: () => options.onEvent?.(record), catch: RuntimeError.from }).pipe(
            Effect.catch(error => Effect.sync(() => report(error))),
          )
        }
        for (const work of committed) yield* work.pipe(Effect.catchCause(reportCause))
      }
      yield* cleanCancellations.pipe(Effect.catchCause(reportCause))
      yield* observePromises.pipe(Effect.catchCause(reportCause))
    })
    const waitFor = <Value>(node: Atom<Value | undefined>) => Effect.gen(function* () {
      const result = yield* Deferred.make<Value, Error>()
      const check = () => {
        try {
          const value = store.get(node)
          if (value !== undefined) Deferred.doneUnsafe(result, Effect.succeed(value))
        } catch (error) { Deferred.doneUnsafe(result, Effect.fail(RuntimeError.from(error))) }
      }
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => { const stop = store.sub(node, check); check(); return stop }),
        () => Deferred.await(result),
        stop => Effect.sync(stop),
      )
    })
    // claimWork retains the producer's completion boundary through final handle admission (tla/InputRetention.tla, AcknowledgementRequiresSuccess).
    const claimWork = <Work extends { readonly ref: EffectRef }>(work: Work) => {
      const completion = Deferred.makeUnsafe<void>()
      completing.set(effectKey(work.ref), completion)
      return { work, completion }
    }
    const drain = () => Effect.gen(function* () {
      while (true) {
        if (!store.get(executionDefect) && options.canDrive && !(yield* options.canDrive)) return
        yield* afterCommit()
        const next = yield* enqueue(Effect.gen(function* () {
          if (closed) return
          if (persistenceFailure) return yield* persistenceFailure
          const cancellation = snapshot.cancellations()[0]
          if (cancellation) {
            yield* appendNow(cancellation)
            return { kind: "delivery" as const }
          }
          const delivery = yield* Effect.try({ try: () => snapshot.deliveries()[0], catch: RuntimeError.from })
          if (delivery) {
            yield* appendNow(delivery)
            return { kind: "delivery" as const }
          }
          for (const [key, work] of localRecovery) {
            if (store.get(executionDefect)) { localRecovery.clear(); break }
            localRecovery.delete(key)
            if (snapshot.promise(work.ref) || snapshot.effect(work.ref)?.cleanup?.request) continue
            const prior = operationSettlement(snapshot.effect(work.ref))?.outcome
            const value = prior?.status === "fulfilled" ? yield* Schema.decodeUnknownEffect(ExecutionResult)(prior.value).pipe(Effect.mapError(RuntimeError.from)) : undefined
            if (value?.type === "promise" && value.deadlineAt !== undefined && value.deadlineAt <= (yield* Clock.currentTimeMillis)) {
              yield* appendNow({ type: "PromiseSettled", ref: work.ref, result: { status: "rejected", reason: { _tag: "PromiseTimedOut", deadlineAt: value.deadlineAt } } })
              continue
            }
            dispatched.add(key)
            return { kind: "work" as const, ...claimWork(work), recovering: true as const }
          }
          const work = yield* Effect.try({ try: () => snapshot.effects().find(work => !work.ref || !dispatched.has(effectKey(work.ref))), catch: RuntimeError.from })
          if (!work) return
          const ref = work.ref ?? { seq: snapshot.position, atom: work.atom, act: work.request.act }
          if (!work.ref) {
            const request = yield* Effect.try({ try: () => definition.requestEvent(ref, work.request, work.origin), catch: RuntimeError.from })
            yield* appendNow(request)
          }
          const recorded = snapshot.effect(ref)?.request
          if (!recorded) return yield* Effect.fail(new RuntimeError("Effect execution requires a committed request"))
          dispatched.add(effectKey(recorded.ref))
          return { kind: "work" as const, ...claimWork({ ...work, ref: recorded.ref }), recovering: false as const }
        }))
        if (!next) return
        if (next.kind === "delivery") continue
        const { work, completion } = next
        const key = effectKey(work.ref)
        yield* Effect.gen(function* () {
          yield* afterCommit()
          let lifetime = lifetimes.get(key)
          if (!lifetime) {
            const executionScope = yield* Scope.fork(scope)
            const signal = yield* Effect.abortSignal.pipe(Effect.provideService(Scope.Scope, executionScope))
            lifetime = { scope: executionScope, signal }
            lifetimes.set(key, lifetime)
          }
          const signal = lifetime.signal
          if (snapshot.effect(work.ref)?.cleanup?.request) {
            dispatched.delete(key)
            return
          }
          let attemptId = (yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt])).join(":")
          let executionSequence = 0
          let retryStarted = false
          const registerPromiseTimeout = (timeoutMs: number | undefined) => Effect.try({ try: () => {
            if (timeoutMs === undefined) return
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RuntimeError("Promise timeoutMs must be a positive safe integer")
            promiseTimeouts.set(key, timeoutMs)
          }, catch: RuntimeError.from })
          const execution: typeof EffectExecution.Service = {
            ref: work.ref,
            signal: signal,
            retry: (operation, retryOptions) => Effect.gen(function* () {
              if (retryStarted) return yield* Effect.fail(new RuntimeError("An effect execution supports one retry boundary"))
              retryStarted = true
              const beforeAttempt = Effect.suspend(() => closed || signal.aborted || snapshot.effect(work.ref)?.cleanup?.request ? Effect.interrupt : Effect.void)
              return yield* retryOperation(operation, { ...retryOptions, attemptTimeoutMs: retryOptions.attemptTimeoutMs === undefined ? executionAttemptTimeoutMs : retryOptions.attemptTimeoutMs }, {
                previous: snapshot.retry(work.ref), beforeAttempt,
                wait: dueAt => waitForRetry(work.ref, "execution", dueAt).pipe(Effect.andThen(Effect.gen(function* () {
                  attemptId = (yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt])).join(":")
                  executionSequence = 0
                }))),
                record: (attempt, dueAt, reason) => execution.record({ type: "RetryScheduled", ref: work.ref, attempt, dueAt, reason }),
              })
            }),
            publish: payload => Effect.suspend(() => closed || signal.aborted || snapshot.effect(work.ref)?.cleanup?.request
              ? Effect.void
              : executionStream.publish({ ...(options.delivery ? { address: options.delivery.address } : {}), ref: work.ref, attemptId, sequence: executionSequence++, payload })),
            cancel: runtime.cancel,
            submit: (operation, options) => Effect.gen(function* () {
              if (signal.aborted) return yield* Effect.interrupt
              yield* registerPromiseTimeout(options?.timeoutMs)
              const handle = yield* runAttempt(operation, executionAttemptTimeoutMs, () => retryStarted)
              const value = yield* normalizePromise(work.ref, { type: "promise", handle })
              yield* append({ type: "EffectSettled", ref: work.ref, outcome: { status: "fulfilled", value } })
              return handle
            }).pipe(Effect.uninterruptible),
            get: store.get,
            waitFor,
            record: event => enqueue(Effect.suspend(() => snapshot.effect(work.ref)?.cleanup?.request ? Effect.void : appendNow(event as unknown as RuntimeEvent<Event>))),
            fork: (operation, options) => Effect.gen(function* () {
              const context = yield* Effect.context<Effect.Services<typeof operation>>()
              const id = effectKey(work.ref)
              if (signal.aborted) return yield* Effect.interrupt
              yield* registerPromiseTimeout(options?.timeoutMs)
              yield* runtime.fork(id, runAttempt(operation, executionAttemptTimeoutMs, () => retryStarted).pipe(
                Effect.provide(context),
                Effect.flatMap(result => runtime.deliver(work.ref, (Array.isArray(result) ? result : [result]) as readonly Event[])),
                Effect.catch(error => Schema.is(AttemptTimedOut)(error) ? append({ type: "PromiseSettled", ref: work.ref, result: { status: "rejected", reason: { _tag: error._tag, timeoutMs: error.timeoutMs } } }) : Effect.fail(error)),
                Effect.catchCause(cause => Cause.hasDies(cause) ? recordDeath(work.ref, cause) : Effect.failCause(cause)),
              ))
              return { executor: "local" as const, id }
            }),
          }
          const fiber = yield* runAttempt(Effect.suspend(() => work.execute(resolve(work.request))), executionAttemptTimeoutMs, () => retryStarted).pipe(
            Effect.provideService(EffectExecution, execution),
            Effect.provide(services),
            Effect.flatMap(result => Schema.decodeEffect(ExecutionResult)(result).pipe(Effect.mapError(String))),
            Effect.map(value => ({ status: "fulfilled" as const, value })),
            Effect.catch(reason => Effect.succeed({ status: "rejected" as const, reason: Schema.is(AttemptTimedOut)(reason) ? { _tag: reason._tag, timeoutMs: reason.timeoutMs } : reason })),
            Effect.forkIn(scope),
          )
          executions.set(key, fiber)
          for (const waiter of executionWaiters) yield* Deferred.succeed(waiter, undefined)
          executionWaiters.clear()
          if (signal.aborted) yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          if (Exit.isFailure(exit)) {
            executions.delete(key)
            dispatched.delete(key)
            if (snapshot.effect(work.ref)?.cleanup?.request || snapshot.promise(work.ref)) return
            if (!Cause.hasDies(exit.cause)) return yield* Effect.failCause(exit.cause)
            yield* recordDeath(work.ref, exit.cause)
            return
          }
          const outcome = exit.value.status === "fulfilled" ? { ...exit.value, value: yield* normalizePromise(work.ref, exit.value.value) } : exit.value
          if (next.recovering) {
            let result: PromiseSettled["result"] | undefined
            if (outcome.status === "rejected") result = outcome
            else if (outcome.value.type === "value") result = { status: "fulfilled", value: outcome.value.value }
            else if (outcome.value.handle.executor !== "local" || outcome.value.handle.id !== next.work.handle.id) return yield* Effect.fail(new RuntimeError("Recovered local work changed its execution handle"))
            if (result) {
              const settlement = yield* Schema.decodeEffect(Schema.toType(PromiseSettled))({ type: "PromiseSettled", ref: work.ref, result }).pipe(Effect.mapError(RuntimeError.from))
              yield* append(settlement)
            }
          } else {
            const settlement = yield* Schema.decodeEffect(Schema.toType(EffectSettled))({ type: "EffectSettled", ref: work.ref, outcome }).pipe(Effect.mapError(RuntimeError.from))
            yield* append(settlement)
          }
          executions.delete(key)
          dispatched.delete(effectKey(work.ref))
          if (outcome.status === "rejected" || outcome.value.type === "value") {
            yield* Scope.close(lifetime.scope, Exit.succeed(undefined))
            lifetimes.delete(key)
          }
        }).pipe(Effect.ensuring(Effect.sync(() => { completing.delete(key) }).pipe(Effect.andThen(Deferred.succeed(completion, undefined)))))
      }
    })
    const send = (events: readonly RuntimeEvent<Event>[], when?: (get: ActorRuntime<Event>["get"]) => boolean, owner?: EffectRef) => Effect.gen(function* () {
      if (options.inspect) return yield* Effect.fail(new RuntimeError("Actor inspection cannot send events"))
      yield* Deferred.await(ready)
      const now = yield* Clock.currentTimeMillis
      for (const waiting of retryWaits.values()) if (waiting.dueAt <= now) yield* Deferred.succeed(waiting.wake, undefined)
      let admitted = false
      let cursor = 0
      yield* enqueue(Effect.gen(function* () {
        if (persistenceFailure) return yield* persistenceFailure
        const defect = store.get(executionDefect)
        if (defect && !(cleanupWork().length && events.every(event => Schema.is(EffectCancelled)(event)))) return yield* Effect.fail(new WatchdogTerminalError(defect.diagnostic))
        if (owner && snapshot.effect(owner)?.cleanup?.request) return
        if (!admitted) {
          if (when && !(yield* Effect.try({ try: () => when(store.get), catch: RuntimeError.from }))) return
          admitted = true
        }
        while (cursor < events.length) {
          const event = events[cursor]!
          if (!hasCoreEventType(event)) yield* Effect.try({ try: () => store.validate(setup.effects, event), catch: RuntimeError.from })
          yield* appendNow(event)
          cursor++
        }
        yield* schedule
      })).pipe(Effect.retry({ while: error => error instanceof PromiseNotReady, schedule: Schedule.spaced(deliveryRetryIntervalMs) }))
    })

    const runtime: ActorRuntime<Event> = {
      execution: executionStream.stream,
      promisePolicy: resolutionPolicy,
      ready: Deferred.await(ready),
      onReady: recover => Effect.sync(() => {
        if (setup !== undefined) throw new RuntimeError("Recovery must be registered during service construction")
        recovery.push(recover)
      }),
      onCommit: work => Effect.sync(() => {
        if (setup !== undefined) throw new RuntimeError("Commit hooks must be registered during service construction")
        committed.push(work)
      }),
      get: store.get,
      sub: store.sub,
      record: append,
      send,
      fork: (id, work) => Effect.gen(function* () {
        if (options.inspect) return yield* Effect.fail(new RuntimeError("Actor inspection cannot fork work"))
        if (closed || background.has(id)) return yield* Effect.fail(new RuntimeError(`Cannot start background work: ${id}`))
        const fiber = yield* work.pipe(
          Effect.catchCause(cause => Effect.sync(() => { if (!closed && !Cause.hasInterruptsOnly(cause)) errors.push(Cause.hasDies(cause) ? new WatchdogTerminalError(Cause.pretty(cause)) : new RuntimeError(Cause.pretty(cause))) })),
          Effect.ensuring(Effect.sync(() => { background.delete(id) })),
          Effect.forkIn(scope),
        )
        background.set(id, fiber)
      }),
      deliver: (ref, events) => send(events, undefined, ref),
      cancel: (ref, reason) => send([{ type: "EffectCancelled", ref, reason }]),
      interrupt: id => Effect.gen(function* () {
        const fiber = background.get(id)
        if (!fiber) return
        yield* Effect.forkIn(Fiber.interrupt(fiber), scope)
      }),
    }
    const run = (effect: Effect.Effect<void, Error>) => Effect.suspend(() =>
      closed ? Effect.fail(new RuntimeError("Actor store is closed")) : Effect.acquireUseRelease(effect.pipe(Effect.forkIn(scope)), Fiber.join, Fiber.interrupt),
    )
    const closing = yield* Effect.cached(Effect.gen(function* () {
      closed = true
      for (const waiting of retryWaits.values()) yield* Deferred.succeed(waiting.wake, undefined)
      for (const unsubscribe of subscriptions) unsubscribe()
      subscriptions.clear()
      yield* Scope.close(scope, Exit.succeed(undefined)).pipe(Effect.ensuring(Effect.gen(function* () {
        yield* Queue.shutdown(admissions)
        yield* Queue.shutdown(processing)
        yield* Queue.shutdown(notifications)
        if (!options.executionStreamBus) yield* executionStream.close
        definition?.dispose()
        trees?.release(projectionContext)
        store.dispose()
      })))
    }).pipe(Effect.uninterruptible))
    const close = closing
    return yield* Effect.gen(function* () {
      yield* Effect.gen(function* () {
        while (true) yield* (yield* Queue.take(admissions))
      }).pipe(Effect.forkIn(scope))
      services = yield* buildServices()
      const stored = options.journal ? yield* (options.journal.treeCheckpoint?.read ?? options.journal.readCheckpoint) : undefined
      const checkpoint = stored ? yield* Effect.try({ try: () => retireCheckpoint(decodeCheckpoint(stored.payload), digestMinBytes), catch: RuntimeError.from }) : undefined
      if (stored && checkpoint && checkpoint.position !== stored.position) return yield* Effect.fail(new RuntimeError("Checkpoint payload position differs from journal metadata"))
      checkpointSeed = checkpoint
      checkpointPosition = checkpoint?.position ?? 0
      // Atomic checkpoint commits make the prefix durable; recovery only needs its suffix.
      let history: readonly Recorded<Event>[] | undefined = options.journal
        ? checkpoint ? yield* options.journal.readAfter(checkpoint.position) : yield* options.journal.read
        : (options.events ?? []).map(event => ({ event }))
      let readFull: typeof ReplayContext.Service["readFull"] | undefined = yield* Effect.cached(checkpoint && options.journal ? options.journal.read : Effect.succeed(history))
      setup = yield* options.setup.pipe(
        Effect.provideService(ReplayContext, { records: history, readFull, ...(checkpoint ? { checkpoint } : {}) }),
        Effect.provideService(Scope.Scope, scope), Effect.provide(options.actorContext(services)),
      )
      const inputs = options.journal ? yield* options.journal.readInputs : []
      for (const input of inputs) persistedInputRefs.set(effectKey(input.ref), input.ref)
      definition = createEventLog({ ...(trees ? { trees } : {}), inputs, schema: setup.schema, ...(setup.decodeEvent ? { decodeEvent: setup.decodeEvent } : {}), digestMinBytes, atoms: { ...setup.effects, "host.message.replies": messageReplies({ schema: setup.schema,
        methods: setup.contracts, ...(options.delivery ? { address: options.delivery.address } : {}),
      }) }, ...(checkpoint ? { checkpoint } : {}) })
      // takeHistory releases startup records and their cached reader before the actor's generator suspends for its lifetime.
      const takeHistory = () => { const records = history!; history = undefined; readFull = undefined; return records }
      snapshot = yield* Effect.try({ try: () => definition.replay(takeHistory()), catch: RuntimeError.from })
      if (options.journal && !options.inspect) {
        const retained = [...snapshot.pending(), ...snapshot.deferred(), ...snapshot.cancelled()].map(({ ref, request }) => ({ ref, request }))
        const known = new Set(inputs.map(input => effectKey(input.ref)))
        const missing = retained.filter(input => !known.has(effectKey(input.ref)) && snapshot.effect(input.ref)?.request.request.input._tag === "InputDigest")
        if (missing.length) {
          yield* options.journal.append(snapshot.position, [], { put: missing })
          for (const input of missing) persistedInputRefs.set(effectKey(input.ref), input.ref)
        }
      }
      for (const cancellation of snapshot.cancelled()) queueCleanup(cancellation)
      const deferred = yield* Effect.try({ try: () => snapshot.deferred(), catch: RuntimeError.from })
      // localRecovery reruns the originating act with its recorded reference and deadline; implementations must recreate local producers (packages/platform/test/properties/runtime/deferred-recovery.ts, ownedProducerRecovery).
      for (const work of deferred) if (work.handle.executor === "local") localRecovery.set(effectKey(work.ref), work)
      yield* Effect.try({ try: sync, catch: RuntimeError.from })
      if (!options.inspect) {
        yield* Deferred.succeed(ready, undefined)
        for (const recover of recovery) yield* recover
        yield* Effect.gen(function* () {
          while (true) {
            const completions = yield* Queue.takeAll(processing)
            yield* drain().pipe(Effect.catchCause(reportCause))
            for (const completion of completions) yield* Deferred.succeed(completion, undefined)
          }
        }).pipe(Effect.forkIn(scope))
        yield* schedule
      }
      const api = {
        execution: { stream: executionStream.stream, policy: executionStream.policy },
        get: store.get,
        sub: <Value>(node: Atom<Value>, listener: () => void) => {
          if (closed) throw new RuntimeError("Actor store is closed")
          const stop = store.sub(node, () => { try { listener() } catch (error) { console.error("Subscription error:", error) } })
          const unsubscribe = () => { stop(); subscriptions.delete(unsubscribe) }
          subscriptions.add(unsubscribe)
          return unsubscribe
        },
        snapshot: () => snapshot,
        receive: (body: Schema.Json, metadata: DeliveryMetadata): Effect.Effect<MessageReceipt, Error> => enqueue(Effect.gen(function* () {
          if (persistenceFailure) return yield* persistenceFailure
          const journal = options.journal
          if (!journal || !("readMessage" in journal)) return yield* Effect.fail(new RuntimeError("Message admission requires an indexed journal"))
          const context = yield* Schema.decodeEffect(MessageMetadata, { onExcessProperty: "error" })(metadata).pipe(Effect.mapError(InvalidMessage.from))
          if (context.invocation) return yield* Effect.fail(new InvalidMessage("Invocation metadata is established by the receiver"))
          let message = context
          let input: unknown = body
          if (!context.inReplyTo && typeof body === "object" && body !== null && "method" in body) {
            if ("cancel" in body) {
              const request = yield* Schema.decodeUnknownEffect(MethodCancellation, { onExcessProperty: "error" })(body).pipe(Effect.mapError(InvalidMessage.from))
              const method = Object.hasOwn(setup.contracts, request.method) ? setup.contracts[request.method] : undefined
              if (!method?.onCancel) return yield* Effect.fail(new InvalidMessage(`Method is not cancellable: ${request.method}`))
              const original = yield* journal.readMessage(request.cancel.id)
              const invocation = original?.record.message?.invocation
              if (!invocation || invocation.method !== request.method) return yield* Effect.fail(new InvalidMessage("Cancellation requires a matching invocation"))
              if (!isDeepStrictEqual(original?.record.message?.from, context.from)) return yield* Effect.fail(new InvalidMessage("Cancellation requires the invoking sender"))
              input = yield* Effect.try({ try: () => method.onCancel!(invocation.input, { id: request.cancel.id, ref: { method: request.method, id: request.cancel.id }, reason: request.cancel.reason }), catch: InvalidMessage.from })
            } else {
              const invocation = yield* Schema.decodeUnknownEffect(MethodInvocation, { onExcessProperty: "error" })(body).pipe(Effect.mapError(InvalidMessage.from))
              const method = Object.hasOwn(setup.contracts, invocation.method) ? setup.contracts[invocation.method] : undefined
              if (!method) return yield* Effect.fail(new InvalidMessage(`Unknown actor method: ${invocation.method}`))
              input = yield* Effect.try({ try: () => method.onReceive(invocation.input, { id: context.id, ref: { method: invocation.method, id: context.id } }), catch: InvalidMessage.from })
              message = { ...context, invocation }
            }
          } else if (!context.inReplyTo) return yield* Effect.fail(new InvalidMessage("Actor requests require a method invocation"))
          const event = context.inReplyTo ? yield* Schema.decodeEffect(Schema.Json)(body).pipe(Effect.mapError(InvalidMessage.from)) : yield* Schema.decodeUnknownEffect(Schema.toType(setup.schema), { onExcessProperty: "error" })(input).pipe(Effect.mapError(InvalidMessage.from))
          if (!context.inReplyTo && typeof event === "object" && event !== null && hasCoreEventType(event)) return yield* Effect.fail(new InvalidMessage("Actor inputs must be domain events"))
          if (message.invocation && Schema.is(MessageAddress)(message.from) && !options.delivery) return yield* Effect.fail(new RuntimeError("Addressed requests require a delivery adapter"))
          const previous = yield* journal.readMessage(message.id)
          if (previous) {
            if (!isMessageReceived(previous.record.event) || !isDeepStrictEqual(previous.record.message, message) || !isDeepStrictEqual(previous.record.event.body, event)) return yield* Effect.fail(new MessageConflict("Message identity reused with different input or sender"))
            yield* journal.acknowledge
            return { id: message.id, position: previous.position }
          }
          const defect = store.get(executionDefect)
          if (defect) return yield* Effect.fail(new WatchdogTerminalError(defect.diagnostic))
          if (!context.inReplyTo) yield* Effect.try({ try: () => store.validate(setup.effects, event as Event), catch: InvalidMessage.from })
          const position = snapshot.position + 1
          const json = yield* Schema.decodeUnknownEffect(Schema.Json)(event).pipe(Effect.mapError(RuntimeError.from))
          yield* appendNow({ type: "MessageReceived", body: json }, { message })
          return { id: message.id, position }
        })),
        cancel: (ref: EffectRef, reason: Schema.Json) => run(runtime.cancel(ref, reason)),
        resume: run(send([])),
        checkpoint: enqueue(Effect.gen(function* () {
          if (!options.journal) return yield* Effect.fail(new RuntimeError("Checkpointing requires a journal"))
          const checkpoint = snapshot.checkpoint()
          if (!checkpoint) return yield* Effect.fail(new RuntimeError("Cannot checkpoint while work is pending or initialised atoms are unread"))
          yield* persistCheckpoint(snapshot.position, [], checkpoint).pipe(Effect.mapError(RuntimeError.from))
          checkpointPosition = snapshot.position
        })),
        active: () => [...background.keys()],
        recoveryState: (): RecoveryState => {
          const failure = runtimeFailure(true)
          if (failure) throw failure
          const cleanup = cleanupWork()
          // progressCursor is the position after the last settlement, so the scan runs back from the end.
          let progressCursor = snapshot.seed?.position ?? 0
          for (let index = snapshot.records.length - 1; index >= 0; index--) {
            const event = snapshot.records.at(index)!.event
            if (Schema.is(EffectSettled)(event) || Schema.is(PromiseSettled)(event) || Schema.is(CancellationOutcome)(event)) {
              progressCursor = (snapshot.seed?.position ?? 0) + index + 1
              break
            }
          }
          const deferred = snapshot.deferred()
          const pendingRefs = [...snapshot.effects().flatMap(work => work.ref ? [work.ref] : []), ...deferred.map(work => work.ref)]
          const pendingKeys = [...pendingRefs.map(effectKey), ...cleanup.map(work => `cancellation:${effectKey(work.ref)}`)]
          if (pendingKeys.length && pendingKeys.every(key => retryWaits.has(key)) && !snapshot.cancellations().length && !snapshot.deliveries().length) {
            const times = pendingKeys.map(key => retryWaits.get(key)!.dueAt)
            for (const work of deferred) {
              const outcome = operationSettlement(snapshot.effect(work.ref))?.outcome
              const value = outcome?.status === "fulfilled" ? Schema.decodeUnknownSync(ExecutionResult)(outcome.value) : undefined
              if (value?.type === "promise" && value.deadlineAt !== undefined) times.push(value.deadlineAt)
            }
            return { progressCursor, status: "parked", wakeAt: Math.min(...times) }
          }
          if (cleanup.length) return { progressCursor, status: "running" }
          // recoveryState preserves live inline execution without a deadline (packages/platform/test/properties/runtime/inline-execution.ts, inlineExecutionSupervision).
          if (executions.size && snapshot.effects().length) return { progressCursor, status: "running" }
          const live = deferred.filter(work => work.handle.executor === "local" && background.has(work.handle.id))
          if (live.length && !snapshot.effects().length && !snapshot.pending().length && !snapshot.cancellations().length && !snapshot.deliveries().length) {
            const deadlines = deferred.map(work => {
              const outcome = operationSettlement(snapshot.effect(work.ref))?.outcome
              const value = outcome?.status === "fulfilled" ? Schema.decodeUnknownSync(ExecutionResult)(outcome.value) : undefined
              return value?.type === "promise" ? value.deadlineAt : undefined
            })
            if (deadlines.every((at): at is number => at !== undefined)) return { progressCursor, status: "running", wakeAt: Math.min(...deadlines) }
          }
          if (snapshot.effects().length || snapshot.pending().length || snapshot.cancellations().length || snapshot.deliveries().length || deferred.some(work => work.handle.executor === "local")) return { progressCursor, status: "pending" }
          if (!deferred.length) return { progressCursor, status: "settled" }
          const deadlines = deferred.map(work => {
            const outcome = operationSettlement(snapshot.effect(work.ref))?.outcome
            const value = outcome?.status === "fulfilled" ? Schema.decodeUnknownSync(ExecutionResult)(outcome.value) : undefined
            const recordedAt = snapshot.records.find(record => Schema.is(EffectRequested)(record.event) && effectKey(record.event.ref) === effectKey(work.ref))?.recordedAt ?? 0
            return promiseDeadline(work.handle, recordedAt, resolutionPolicy, value?.type === "promise" ? value.deadlineAt : undefined)
          })
          return { progressCursor, status: "parked", wakeAt: Math.min(...deadlines) }
        },
        recover: run(Effect.gen(function* () {
          const completion = scheduled
          if (completion && !executions.size) {
            const started = Deferred.makeUnsafe<void>()
            executionWaiters.add(started)
            yield* Effect.raceFirst(Deferred.await(completion), Deferred.await(started)).pipe(Effect.ensuring(Effect.sync(() => { executionWaiters.delete(started) })))
          }
          const failure = runtimeFailure(true)
          if (failure) return yield* Effect.fail(failure)
        })),
        // wait observes local processing and failures; external promise delivery can arrive after it returns.
        wait: run(Effect.gen(function* () {
          while (true) {
            const completion = scheduled
            if (completion) yield* Deferred.await(completion)
            yield* Fiber.awaitAll([...background.values()])
            if (completion === scheduled && background.size === 0) break
          }
          const failure = runtimeFailure()
          if (failure) return yield* Effect.fail(failure)
        })),
        close,
      }
      return api
    }).pipe(Effect.onError(() => close))
  })
}

// retryOperation preserves recorded attempts and absolute wakes for execution and cleanup (platform/test/bun/effect-retry.test.ts, platform/test/properties/runtime/pending-input-recovery.ts).
function retryOperation<Value, Failure, Services, DecisionServices>(operation: Effect.Effect<Value, Failure, Services>, options: RetryOptions<Failure, DecisionServices>, recovery: {
  readonly previous: RetryScheduled | undefined
  readonly beforeAttempt: Effect.Effect<void, Error>
  readonly wait: (dueAt: number) => Effect.Effect<void, Error>
  readonly record: (attempt: number, dueAt: number, reason: RetryScheduled["reason"]) => Effect.Effect<void, Error>
}) {
  return Effect.gen(function* () {
    const timeoutMs = options.attemptTimeoutMs
    if (timeoutMs !== undefined && timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) return yield* Effect.fail(new RuntimeError("Attempt timeoutMs must be a positive safe integer"))
    const work = runAttempt(operation, options.attemptTimeoutMs)
    let attempt = recovery.previous?.attempt ?? 0
    let dueAt = recovery.previous?.dueAt
    while (true) {
      yield* recovery.beforeAttempt
      if (dueAt !== undefined) yield* recovery.wait(dueAt).pipe(Effect.interruptible)
      yield* recovery.beforeAttempt
      const result = yield* Effect.result(work)
      if (result._tag === "Success") return result.success
      const decision = yield* options.decide(result.failure, attempt)
      if (!decision) return yield* Effect.fail(result.failure)
      if (!Number.isSafeInteger(decision.delayMs) || decision.delayMs < 0) return yield* Effect.fail(new RuntimeError("Retry delayMs must be a nonnegative safe integer"))
      dueAt = (yield* Clock.currentTimeMillis) + decision.delayMs
      yield* recovery.record(++attempt, dueAt, decision.reason)
    }
  })
}

// runAttempt hands the fallback deadline to an explicit retry boundary and waits for local finalizers before returning a timeout (quint/attemptDeadline.qnt, interruptedBeforeDecisionTest).
function runAttempt<Value, Failure, Services>(operation: Effect.Effect<Value, Failure, Services>, timeoutMs: number | null = DEFAULT_ATTEMPT_TIMEOUT_MS, delegated?: () => boolean): Effect.Effect<Value, Failure | AttemptTimedOut, Services> {
  if (timeoutMs === null) return operation
  const deadline = Effect.sleep(timeoutMs).pipe(Effect.andThen(Effect.suspend(() => delegated?.() ? Effect.never : Effect.fail(AttemptTimedOut.make({ timeoutMs })))), Effect.interruptible)
  return Effect.raceFirst(operation.pipe(Effect.interruptible), deadline)
}
