import type { ReadonlyIndex } from "./log-view"
import { initialStateSeed, type StateSeed } from "../initialise"
import { ActorCommitError, RuntimeError, PromiseNotReady, PromiseTimedOut, ExecutionResult, EffectCancelled, effectKey, type EffectRef } from "./effects"
import { createStore } from "../atoms/store"
import { createRecordSource } from "./event-source"
import { atom, type Atom } from "../atoms/atom"
import { EventLog } from "../services/event-log"
import { Scheduler } from "../services/scheduler"
import { EffectExecution } from "../services/effect-execution"
import { createExecutionStream, type ExecutionStream, type ExecutionStreamPolicy } from "../services/execution-stream"
import { EffectRequested, EffectSettled, PromiseSettled, hasCoreEventType } from "./events"
import { cancelAct, type ActCancellation } from "../atoms/act"
import type { RuntimeEvent, JournalEvent, Journal, MessageJournal, RecordMetadata } from "../services/journal"
import type { ActorRuntime, ActorSetup, Requirements } from "./contracts"
import type { ActorDefinition } from "../actor/definition"
import { type MessageMetadata as DeliveryMetadata, type MessageReceipt, MessageAddress, MessageDelivered, MessageMetadata, MessageConflict, InvalidMessage, isMessageReceived } from "../actor/message"
import type { ThreadCoordinate } from "../actor/thread"
import { MethodInvocation, MethodCancellation, type ActorMethods } from "../actor/method"
import { createEventLog, type EffectCheckpoint } from "./replay"
import { isDeepStrictEqual } from "node:util"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Cause, Schema, Option, Queue, Schedule, Clock, Random } from "effect"
import { WatchdogTerminalError, type RecoveryState } from "../services/watchdog"
import { Promises, DEFAULT_PROMISE_POLICY, promiseDeadline, promisePolicy, type PromisePolicy } from "../services/promises"
import { DEFAULT_CHECKPOINT_MAX_BYTES, checkpointDigest, decodeCheckpoint, encodeCheckpoint } from "../services/checkpoint"
import { observeRequest, DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES } from "./input-digest"
import { messageReplies } from "./messages"
import { DeliverMessage, type MessageDelivery } from "../services/invocation"
import { select } from "./stores/thread"

export type CheckpointPolicy =
  | { readonly mode: "threshold"; readonly options: { readonly everyEvents: number; readonly maxBytes?: number } }
  | { readonly mode: "manual"; readonly options?: { readonly maxBytes?: number } }

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
  readonly cancellation?: { readonly retryIntervalMs?: number }
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
  readonly cancellation?: { readonly retryIntervalMs?: number }
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
    const deliveryRetryIntervalMs = options.promiseDelivery?.retryIntervalMs ?? DEFAULT_PROMISE_POLICY.retryIntervalMs
    if (!Number.isSafeInteger(deliveryRetryIntervalMs) || deliveryRetryIntervalMs < 1) return yield* Effect.fail(new RuntimeError("Promise delivery retryIntervalMs must be a positive safe integer"))
    let setup: ActorSetup<Event, Atoms, Contracts>
    type RuntimeAtoms = Atoms & { readonly "host.message.replies": ReturnType<typeof messageReplies<Event>> }
    let definition: ReturnType<typeof createEventLog<Event, RuntimeAtoms>>
    let snapshot: ReturnType<typeof definition.replay>
    const localRecovery = new Map<string, ReturnType<typeof snapshot.deferred>[number]>()
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
    const encodeChecked = (checkpoint: EffectCheckpoint) => {
      const payload = encodeCheckpoint(checkpoint)
      if (payload.byteLength > checkpointMaxBytes) throw new RuntimeError(`Checkpoint exceeds maxBytes ${checkpointMaxBytes}`)
      return payload
    }
    const store = createStore(Context.make(EventLog, {
      events: source.observedEvents,
      records: source.observedRecords,
      bindings,
      position: () => checkpointSeed?.position ?? 0,
      initialState: () => initialState ??= initialStateSeed(store.get(source.records), checkpointSeed),
      effect: ref => {
        const state = snapshot?.effect(ref)
        return state ? { ...state, request: Object.freeze(observeRequest(state.request)) } : undefined
      },
      promise: ref => snapshot?.promise(ref),
    }))
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
    // executionWaiters bound recovery waiting to the start of inline execution (packages/platform/test/properties/watchdog/live-inline.ts, liveInline).
    const executionWaiters = new Set<Deferred.Deferred<void>>()
    const cleaning = new Set<string>()
    const pendingCleanup = new Map<string, ActCancellation>()
    const queueCleanup = (cancellation: ActCancellation) => {
      const key = JSON.stringify([effectKey(cancellation.ref), cancellation.handle ?? null])
      if (!cleaning.has(key)) pendingCleanup.set(key, cancellation)
    }
    const cancellationRetryIntervalMs = options.cancellation?.retryIntervalMs ?? DEFAULT_CANCELLATION_RETRY_INTERVAL_MS
    if (!Number.isSafeInteger(cancellationRetryIntervalMs) || cancellationRetryIntervalMs < 1) return yield* Effect.fail(new RuntimeError("Cancellation retryIntervalMs must be a positive safe integer"))
    const background = new Map<string, Fiber.Fiber<void, never>>()
    const deadlineTimers = new Map<string, Fiber.Fiber<void, never>>()
    const errors: Error[] = []
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
        const persistence = checkpoint
          ? Effect.try({ try: () => encodeChecked(checkpoint), catch: RuntimeError.from }).pipe(
            Effect.flatMap(payload => checkpointDigest(payload).pipe(Effect.flatMap(digest => journal.appendWithCheckpoint(snapshot.position, records, { position: next.position, payload, digest })))),
          )
          : journal.append(snapshot.position, records)
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
      }
      if (options.journal && checkpoint) checkpointPosition = next.position
      snapshot = next
      for (const { event: record } of records) {
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
        const cancellation = lifecycle?.cancellation
        if (!cancellation) continue
        const cleanup = next.cancelled().find(work => effectKey(work.ref) === effectKey(record.ref))
        if (!cleanup) return yield* Effect.fail(new RuntimeError("Cancellation requires reconstructed input"))
        queueCleanup(cleanup)
        const key = effectKey(cancellation.ref)
        const timer = deadlineTimers.get(key)
        if (timer) yield* Fiber.interrupt(timer).pipe(Effect.forkIn(scope))
        const lifetime = lifetimes.get(key)
        if (lifetime) yield* Scope.close(lifetime.scope, Exit.succeed(undefined))
        lifetimes.delete(key)
        const executing = executions.get(key)
        const deferred = background.get(key)
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
    const promiseTimeouts = new Map<string, number>()
    const normalizePromise = (ref: EffectRef, value: ExecutionResult) => Effect.gen(function* () {
      if (value.type !== "promise") return value
      const prior = snapshot.effect(ref)?.settlement?.outcome
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
      const observer = Context.getOption(services, Promises)
      const events = snapshot.events
      if (observedThrough > events.length || (observedThrough > 0 && events.at(observedThrough - 1) !== lastObserved)) observedThrough = 0
      for (; observedThrough < events.length; observedThrough++, lastObserved = events.at(observedThrough - 1)) {
        const record = events.at(observedThrough)!
        if (!Schema.is(EffectSettled)(record) || record.outcome.status !== "fulfilled") continue
        const result = yield* Schema.decodeUnknownEffect(ExecutionResult)(record.outcome.value).pipe(Effect.mapError(RuntimeError.from))
        if (result.type !== "promise" || snapshot.promise(record.ref) || snapshot.effect(record.ref)?.cancellation) continue
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
    const cleanCancellations = Effect.gen(function* () {
      for (const [key, cancellation] of pendingCleanup) {
        pendingCleanup.delete(key)
        if (cleaning.has(key)) continue
        cleaning.add(key)
        const observer = Context.getOption(services, Promises)
        const cleanup = Effect.gen(function* () {
          if (cancellation.handle && cancellation.handle.executor !== "local" && Option.isSome(observer)) {
            const settlement = snapshot.effect(cancellation.ref)?.settlement?.outcome
            const value = settlement?.status === "fulfilled" ? yield* Schema.decodeUnknownEffect(ExecutionResult)(settlement.value).pipe(Effect.mapError(RuntimeError.from)) : undefined
            yield* observer.value.cancel({ ref: cancellation.ref, handle: cancellation.handle, ...(value?.type === "promise" && value.deadlineAt !== undefined ? { deadlineAt: value.deadlineAt } : {}) })
          }
          yield* cancelAct(cancellation, { get: store.get, cancel: runtime.cancel }).pipe(Effect.provide(services))
        }).pipe(Effect.retry({ schedule: Schedule.spaced(cancellationRetryIntervalMs) }))
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
    const drain = () => Effect.gen(function* () {
      while (true) {
        if (options.canDrive && !(yield* options.canDrive)) return
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
            localRecovery.delete(key)
            if (snapshot.promise(work.ref) || snapshot.effect(work.ref)?.cancellation) continue
            const prior = snapshot.effect(work.ref)?.settlement?.outcome
            const value = prior?.status === "fulfilled" ? yield* Schema.decodeUnknownEffect(ExecutionResult)(prior.value).pipe(Effect.mapError(RuntimeError.from)) : undefined
            if (value?.type === "promise" && value.deadlineAt !== undefined && value.deadlineAt <= (yield* Clock.currentTimeMillis)) {
              yield* appendNow({ type: "PromiseSettled", ref: work.ref, result: { status: "rejected", reason: { _tag: "PromiseTimedOut", deadlineAt: value.deadlineAt } } })
              continue
            }
            dispatched.add(key)
            return { kind: "work" as const, work, recovering: true as const }
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
          return { kind: "work" as const, work: { ...work, ref: recorded.ref }, recovering: false as const }
        }))
        if (!next) return
        if (next.kind === "delivery") continue
        const { work } = next
        yield* afterCommit()
        const key = effectKey(work.ref)
        let lifetime = lifetimes.get(key)
        if (!lifetime) {
          const executionScope = yield* Scope.fork(scope)
          const signal = yield* Effect.abortSignal.pipe(Effect.provideService(Scope.Scope, executionScope))
          lifetime = { scope: executionScope, signal }
          lifetimes.set(key, lifetime)
        }
        const signal = lifetime.signal
        if (snapshot.effect(work.ref)?.cancellation) {
          dispatched.delete(key)
          continue
        }
        let attemptId = (yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt])).join(":")
        let executionSequence = 0
        let retryStarted = false
        const durableRetries = Option.isSome(Context.getOption(services, Scheduler))
        const execution: typeof EffectExecution.Service = {
          ref: work.ref,
          signal: signal,
          retry: (operation, retryOptions) => Effect.gen(function* () {
            if (retryStarted) return yield* Effect.fail(new RuntimeError("An effect execution supports one retry boundary"))
            retryStarted = true
            const previous = snapshot.retry(work.ref)
            let attempt = previous?.attempt ?? 0
            let dueAt = previous?.dueAt
            while (true) {
              if (signal.aborted || snapshot.effect(work.ref)?.cancellation) return yield* Effect.interrupt
              if (dueAt !== undefined) {
                const waiting = { dueAt, wake: Deferred.makeUnsafe<void>() }
                retryWaits.set(key, waiting)
                const now = yield* Clock.currentTimeMillis
                if (dueAt > now) yield* (durableRetries ? Deferred.await(waiting.wake) : Effect.sleep(dueAt - now)).pipe(Effect.ensuring(Effect.sync(() => { retryWaits.delete(key) })))
                retryWaits.delete(key)
                attemptId = (yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt])).join(":")
                executionSequence = 0
              }
              if (signal.aborted || snapshot.effect(work.ref)?.cancellation) return yield* Effect.interrupt
              const result = yield* Effect.result(operation)
              if (result._tag === "Success") return result.success
              const decision = yield* retryOptions.decide(result.failure, attempt)
              if (!decision) return yield* Effect.fail(result.failure)
              if (!Number.isSafeInteger(decision.delayMs) || decision.delayMs < 0) return yield* Effect.fail(new RuntimeError("Retry delayMs must be a nonnegative safe integer"))
              dueAt = (yield* Clock.currentTimeMillis) + decision.delayMs
              attempt++
              yield* execution.record({ type: "RetryScheduled", ref: work.ref, attempt, dueAt, reason: decision.reason })
            }
          }),
          publish: payload => Effect.suspend(() => closed || signal.aborted || snapshot.effect(work.ref)?.cancellation
            ? Effect.void
            : executionStream.publish({ ...(options.delivery ? { address: options.delivery.address } : {}), ref: work.ref, attemptId, sequence: executionSequence++, payload })),
          cancel: runtime.cancel,
          submit: (operation, options) => Effect.gen(function* () {
            if (signal.aborted) return yield* Effect.interrupt
            if (options?.timeoutMs !== undefined) {
              if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) return yield* Effect.fail(new RuntimeError("Promise timeoutMs must be a positive safe integer"))
              promiseTimeouts.set(key, options.timeoutMs)
            }
            const handle = yield* operation
            const value = yield* normalizePromise(work.ref, { type: "promise", handle })
            yield* append({ type: "EffectSettled", ref: work.ref, outcome: { status: "fulfilled", value } })
            return handle
          }).pipe(Effect.uninterruptible),
          get: store.get,
          waitFor,
          record: event => enqueue(Effect.suspend(() => snapshot.effect(work.ref)?.cancellation ? Effect.void : appendNow(event as unknown as RuntimeEvent<Event>))),
          fork: (operation, options) => Effect.gen(function* () {
            const context = yield* Effect.context<Effect.Services<typeof operation>>()
            const id = effectKey(work.ref)
            if (signal.aborted) return yield* Effect.interrupt
            if (options?.timeoutMs !== undefined) {
              if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) return yield* Effect.fail(new RuntimeError("Promise timeoutMs must be a positive safe integer"))
              promiseTimeouts.set(key, options.timeoutMs)
            }
            yield* runtime.fork(id, operation.pipe(
              Effect.provide(context),
              Effect.flatMap(result => runtime.deliver(work.ref, (Array.isArray(result) ? result : [result]) as readonly Event[])),
            ))
            return { executor: "local" as const, id }
          }),
        }
        const fiber = yield* work.execute.pipe(
          Effect.provideService(EffectExecution, execution),
          Effect.provide(services),
          Effect.flatMap(result => Schema.decodeEffect(ExecutionResult)(result).pipe(Effect.mapError(String))),
          Effect.map(value => ({ status: "fulfilled" as const, value })),
          Effect.catch(reason => Effect.succeed({ status: "rejected" as const, reason })),
          Effect.forkIn(scope),
        )
        executions.set(key, fiber)
        for (const waiter of executionWaiters) yield* Deferred.succeed(waiter, undefined)
        executionWaiters.clear()
        if (signal.aborted) yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        executions.delete(key)
        if (Exit.isFailure(exit)) {
          dispatched.delete(key)
          if (snapshot.effect(work.ref)?.cancellation && Cause.hasInterruptsOnly(exit.cause)) continue
          return yield* Effect.failCause(exit.cause)
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
        dispatched.delete(effectKey(work.ref))
        if (outcome.status === "rejected" || outcome.value.type === "value") {
          yield* Scope.close(lifetime.scope, Exit.succeed(undefined))
          lifetimes.delete(key)
        }
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
        if (owner && snapshot.effect(owner)?.cancellation) return
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
      for (const unsubscribe of subscriptions) unsubscribe()
      subscriptions.clear()
      yield* Scope.close(scope, Exit.succeed(undefined)).pipe(Effect.ensuring(Effect.gen(function* () {
        yield* Queue.shutdown(admissions)
        yield* Queue.shutdown(processing)
        yield* Queue.shutdown(notifications)
        if (!options.executionStreamBus) yield* executionStream.close
        definition?.dispose()
        store.dispose()
      })))
    }).pipe(Effect.uninterruptible))
    const close = closing
    return yield* Effect.gen(function* () {
      yield* Effect.gen(function* () {
        while (true) yield* (yield* Queue.take(admissions))
      }).pipe(Effect.forkIn(scope))
      services = yield* buildServices()
      setup = yield* options.setup.pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(options.actorContext(services)))
      const stored = options.journal ? yield* options.journal.readCheckpoint : undefined
      const checkpoint = stored ? yield* Effect.try({ try: () => decodeCheckpoint(stored.payload), catch: RuntimeError.from }) : undefined
      if (stored && checkpoint && checkpoint.position !== stored.position) return yield* Effect.fail(new RuntimeError("Checkpoint payload position differs from journal metadata"))
      checkpointSeed = checkpoint
      checkpointPosition = checkpoint?.position ?? 0
      // Atomic checkpoint commits make the prefix durable; recovery only needs its suffix.
      const history = options.journal
        ? checkpoint ? yield* options.journal.readAfter(checkpoint.position) : yield* options.journal.read
        : (options.events ?? []).map(event => ({ event }))
      definition = createEventLog({ schema: setup.schema, digestMinBytes, atoms: { ...setup.effects, "host.message.replies": messageReplies({ schema: setup.schema,
        methods: setup.contracts, ...(options.delivery ? { address: options.delivery.address } : {}),
      }) }, ...(checkpoint ? { checkpoint } : {}) })
      snapshot = yield* Effect.try({ try: () => definition.replay(history), catch: RuntimeError.from })
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
          const payload = yield* Effect.try({ try: () => encodeChecked(checkpoint), catch: RuntimeError.from })
          const digest = yield* checkpointDigest(payload).pipe(Effect.mapError(RuntimeError.from))
          yield* options.journal.appendWithCheckpoint(snapshot.position, [], { position: snapshot.position, payload, digest }).pipe(Effect.mapError(RuntimeError.from))
          checkpointPosition = snapshot.position
        })),
        active: () => [...background.keys()],
        recoveryState: (): RecoveryState => {
          if (errors.length) throw errors[0]!
          // progressCursor is the position after the last settlement, so the scan runs back from the end.
          let progressCursor = snapshot.seed?.position ?? 0
          for (let index = snapshot.records.length - 1; index >= 0; index--) {
            const event = snapshot.records.at(index)!.event
            if (Schema.is(EffectSettled)(event) || Schema.is(PromiseSettled)(event)) {
              progressCursor = (snapshot.seed?.position ?? 0) + index + 1
              break
            }
          }
          const deferred = snapshot.deferred()
          const pendingRefs = [...snapshot.effects().flatMap(work => work.ref ? [work.ref] : []), ...deferred.map(work => work.ref)]
          if (pendingRefs.length && pendingRefs.every(ref => retryWaits.has(effectKey(ref))) && !snapshot.cancellations().length && !snapshot.deliveries().length) {
            const times = pendingRefs.map(ref => retryWaits.get(effectKey(ref))!.dueAt)
            for (const work of deferred) {
              const outcome = snapshot.effect(work.ref)?.settlement?.outcome
              const value = outcome?.status === "fulfilled" ? Schema.decodeUnknownSync(ExecutionResult)(outcome.value) : undefined
              if (value?.type === "promise" && value.deadlineAt !== undefined) times.push(value.deadlineAt)
            }
            return { progressCursor, status: "parked", wakeAt: Math.min(...times) }
          }
          // recoveryState preserves live inline execution without a deadline (packages/platform/test/properties/runtime/inline-execution.ts, inlineExecutionSupervision).
          if (executions.size && snapshot.effects().length) return { progressCursor, status: "running" }
          const live = deferred.filter(work => work.handle.executor === "local" && background.has(work.handle.id))
          if (live.length && !snapshot.effects().length && !snapshot.pending().length && !snapshot.cancellations().length && !snapshot.deliveries().length) {
            const deadlines = deferred.map(work => {
              const outcome = snapshot.effect(work.ref)?.settlement?.outcome
              const value = outcome?.status === "fulfilled" ? Schema.decodeUnknownSync(ExecutionResult)(outcome.value) : undefined
              return value?.type === "promise" ? value.deadlineAt : undefined
            })
            if (deadlines.every((at): at is number => at !== undefined)) return { progressCursor, status: "running", wakeAt: Math.min(...deadlines) }
          }
          if (snapshot.effects().length || snapshot.pending().length || snapshot.cancellations().length || snapshot.deliveries().length || deferred.some(work => work.handle.executor === "local")) return { progressCursor, status: "pending" }
          if (!deferred.length) return { progressCursor, status: "settled" }
          const deadlines = deferred.map(work => {
            const outcome = snapshot.effect(work.ref)?.settlement?.outcome
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
          if (errors.length) return yield* Effect.fail(errors[0]!)
        })),
        // wait observes local processing and failures; external promise delivery can arrive after it returns.
        wait: run(Effect.gen(function* () {
          while (true) {
            const completion = scheduled
            if (completion) yield* Deferred.await(completion)
            yield* Fiber.awaitAll([...background.values()])
            if (completion === scheduled && background.size === 0) break
          }
          if (errors.length) return yield* Effect.fail(errors[0]!)
        })),
        close,
      }
      return api
    }).pipe(Effect.onError(() => close))
  })
}
