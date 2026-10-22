import { journalCall } from "@clavia/tardigrade-core"
import { recordedOperation } from "../../../../core/src/runtime/operation"
import { completionState } from "../../fixtures/completion-state"
import { DEFAULT_EFFECT_SERVICE_POLICY, effectServicePromises, type EffectServiceClient } from "../../fixtures/effect-service"
import { strict as assert } from "node:assert"
import * as fc from "fast-check"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { act, ActorCommitError, AttemptTimedOut, DEFAULT_ATTEMPT_TIMEOUT_MS, createActorStore, createWatchdog, defineActor, effectAtom, EffectExecution, ExecutionResult, Promises, RuntimeError, StreamTimedOut, withStreamTimeout, effectKey, watchdogKey, WatchdogTerminalError, type EffectRef, type Journal, type Recorded } from "@clavia/tardigrade-core"
import { memoryWatchdog } from "../../fixtures/watchdog"
import { waitFor } from "../../fixtures/wait"

const completion = completionState("lifecycle.completion", Schema.String)
const childCompletion = completionState("lifecycle.child.completion", Schema.String)
const siblingCompletion = completionState("lifecycle.sibling.completion", Schema.Null)
const Event = Schema.Union([Schema.Struct({ type: Schema.Literal("Unused") }), completion.event, childCompletion.event, siblingCompletion.event])
export type LifecycleEvent = typeof Event.Type
const Job = act({ name: "lifecycle.job", input: Schema.String, success: Schema.String, failure: Schema.String })
const Child = act({ name: "lifecycle.child", input: Schema.String, success: Schema.String, failure: Schema.String })
const Sibling = act({ name: "lifecycle.sibling", input: Schema.Null, success: Schema.Null, failure: Schema.String })
export const operationLifecycleCases = fc.record({ input: fc.string(), crash: fc.constantFrom("accepted", "cleanup", "retry", "forwarding"), death: fc.boolean(), forward: fc.boolean(), intervals: fc.record({ startDelayMs: fc.integer({ min: 0, max: 3 }), runDurationMs: fc.integer({ min: 0, max: 3 }), cancelDelayMs: fc.integer({ min: 0, max: 3 }) }), finish: fc.constantFrom("cancel", "success", "failure") }).map(scenario => scenario.finish === "cancel" ? scenario : { ...scenario, death: false, forward: false })
type Scenario = { readonly input: string; readonly crash: "accepted" | "cleanup" | "retry" | "forwarding"; readonly death: boolean; readonly forward: boolean; readonly finish: "cancel" | "success" | "failure"; readonly intervals: { startDelayMs: number; runDurationMs: number; cancelDelayMs: number } }
const policy = { keepAliveIntervalMs: 10, retryIntervalMs: 10, maxRetryIntervalMs: 10 }

// operationLifecycle crosses SQL retention, late handle admission, execution death, and watchdog-owned recovery (core/quint/operationRecovery.qnt, invariant, fullLifecycleTest).
export async function operationLifecycle(journal: Journal<typeof Event.Type>, scenario: Scenario, service: EffectServiceClient) {
  await service.configure({ ...DEFAULT_EFFECT_SERVICE_POLICY, ...scenario.intervals, holdExecution: true, holdCancellationResponse: true, cancelFailures: scenario.crash === "retry" ? 1 : 0, failExecution: scenario.finish === "failure" })
  await Effect.runPromise(Effect.gen(function* () {
    const clock = yield* TestClock.make()
    yield* Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context<never>())
      let version = 1
      let entered = Deferred.makeUnsafe<void>()
      let releaseSubmission = Deferred.makeUnsafe<void>()
      let cleanupEntered = Deferred.makeUnsafe<void>()
      const die = Deferred.makeUnsafe<void>()
      const forwarding = Deferred.makeUnsafe<void>()
      const releaseForwarding = Deferred.makeUnsafe<void>()
      const calls: { kind: "execute" | "cleanup"; input: string; ref: EffectRef; handle?: string }[] = []
      let childRef: EffectRef | undefined
      let producer = false
      const open = () => createActorStore({
        actor: defineActor("lifecycle", Effect.sync(() => {
          const job = Job.request({ input: version === 1 ? scenario.input : "replacement proposal", onSettled: completion.onSettled })
          const sibling = Sibling.request({ input: null, onSettled: siblingCompletion.onSettled })
          const child = Child.request({ input: version === 1 ? scenario.input : "replacement child proposal", onSettled: childCompletion.onSettled })
          return { schema: Event, atom: effectAtom(get => ({ view: null, events: {}, acts: { ...(scenario.death && get(siblingCompletion.state).status === "pending" ? { sibling } : {}), ...(scenario.forward && get(childCompletion.state).status === "pending" ? { child } : {}), ...(get(completion.state).status === "pending" ? { job } : {}) } })) }
        })), journal, checkpoint: { mode: "manual" }, effectInput: { digestMinBytes: 0 }, cancellation: { retryIntervalMs: 10 }, actorContext: Context.pick(),
        services: current => { return Layer.mergeAll(Layer.succeed(Promises, effectServicePromises(service, current)),
          Child.layer((input, { ref }) => Effect.tryPromise({ try: signal => service.submit(effectKey(ref), input, signal), catch: String }).pipe(Effect.map(Child.defer)), { cancel: (input, { ref, handle }) => Effect.gen(function* () {
            calls.push({ kind: "cleanup", input, ref, ...(handle ? { handle: handle.id } : {}) })
            yield* Effect.tryPromise({ try: signal => service.cancel(effectKey(ref), signal), catch: RuntimeError.from })
          }) }),
          Sibling.layer(() => Effect.gen(function* () {
            const execution = yield* EffectExecution
            return Sibling.defer(yield* execution.fork(Deferred.await(die).pipe(Effect.andThen(Effect.die("sibling died")))))
          }).pipe(Effect.mapError(String))), Job.layer((input, { ref }) => Effect.gen(function* () {
            calls.push({ kind: "execute", input, ref })
            yield* Deferred.succeed(entered, undefined)
            if (scenario.crash === "accepted" && version === 1) return yield* Effect.never
            const execution = yield* EffectExecution
            producer = true
            return Job.defer(yield* execution.submit(Deferred.await(releaseSubmission).pipe(Effect.andThen(Effect.tryPromise({ try: signal => service.submit(effectKey(ref), input, signal), catch: RuntimeError.from })), Effect.tap(() => Effect.sync(() => { producer = false })))))
          }).pipe(Effect.mapError(String)), { cancel: (input, { ref, handle, cancel }) => Effect.gen(function* () {
            calls.push({ kind: "cleanup", input, ref, ...(handle ? { handle: handle.id } : {}) })
            if (scenario.crash === "forwarding" && version === 1) { yield* Deferred.succeed(forwarding, undefined); yield* Deferred.await(releaseForwarding) }
            if (childRef) yield* cancel(childRef, "parent cancelled")
            yield* Deferred.succeed(cleanupEntered, undefined)
            if (!handle) return yield* Effect.die("Cleanup lost its remote handle")
            yield* Effect.tryPromise({ try: signal => service.cancel(handle.id, signal), catch: RuntimeError.from })
          }) })) },
      })
      let store = yield* open()
      let online = true
      const db = memoryWatchdog()
      const target = { actor: "lifecycle", instance: "main", thread: "one" }
      const key = watchdogKey(target)
      const watchdog = createWatchdog({ storage: db.storage, policy,
        // @effect-diagnostics-next-line effectSucceedWithVoid:off: An absent probe requires an undefined RecoveryState.
        probe: () => online ? Effect.try({ try: () => store.recoveryState(), catch: error => error instanceof WatchdogTerminalError ? error : RuntimeError.from(error) }) : Effect.succeed(undefined),
        recover: () => Effect.gen(function* () {
          if (!online) { store = yield* open(); online = true }
          yield* store.resume
          yield* store.recover
          return store.recoveryState()
        }), invalidate: () => Effect.suspend(() => store.close.pipe(Effect.tap(() => Effect.sync(() => { online = false })))),
      })
      // observe projects the same durable and volatile facts as operationRecovery.State at synchronized lifecycle boundaries.
      const observe = (ref: EffectRef) => Effect.gen(function* () {
        const operation = recordedOperation(yield* journalCall(() => journal.read()), ref)!
        const child = childRef ? recordedOperation(yield* journalCall(() => journal.read()), childRef) : undefined
        const childState = !childRef ? "none" : !child?.cleanup ? "waiting" : child.cleanup.outcome?.type === "CancellationSettled" && child.cleanup.outcome.outcome.status === "fulfilled" ? "done" : "pending"
        const inputs = yield* journalCall(() => journal.readInputs())
        const input = inputs.some(input => effectKey(input.ref) === effectKey(ref))
        const submission = operation.execution.outcome
        const result = submission?.type === "EffectSettled" && submission.outcome.status === "fulfilled" ? yield* Schema.decodeUnknownEffect(ExecutionResult)(submission.outcome.value) : undefined
        const handle = result?.type === "promise"
        const outcome = operation.cleanup?.outcome
        const cleanup = outcome?.type === "CancellationSettled" && outcome.outcome.status === "fulfilled" ? "done" : outcome ? "blocked" : operation.cleanup ? "running" : "none"
        const execution = store.snapshot().defect ? "died" : operation.cleanup ? "cancelled" : operation.execution.promise ? "done" : "pending"
        const remote = yield* Effect.tryPromise({ try: () => service.job(effectKey(ref)), catch: RuntimeError.from })
        const state = { accepted: true, input, execution, cleanup, producer, created: remote !== null, handle, cleaned: remote?.status === "cancelled",
          child: operation.cleanup ? childState : "none", wake: db.records().get(key)?.status === "pending" && db.alarm() !== null, online }
        const cleanupOwed = ["pending", "running", "retry", "blocked"].includes(state.cleanup)
        const needsInput = state.execution === "pending" || cleanupOwed || state.producer || ["waiting", "pending"].includes(state.child)
        const runnable = state.execution === "pending" || ["pending", "running", "retry"].includes(state.cleanup) || state.producer || state.child === "pending"
        assert.ok(!needsInput || state.input, "operationRecovery.retained")
        if (childRef && ["waiting", "pending"].includes(state.child)) assert.ok(inputs.some(input => effectKey(input.ref) === effectKey(childRef!)), "forwarding lost child input")
        assert.ok(!runnable || state.wake, "operationRecovery.covered")
        assert.ok(!state.created || state.handle, "operationRecovery.handleAdmitted")
        assert.ok(state.cleanup !== "done" || !state.producer && (!state.created || state.cleaned) && state.child !== "waiting", "operationRecovery.cleanupComplete")
      })
      const wake = Effect.gen(function* () {
        const at = db.alarm()
        assert.notEqual(at, null, "runnable obligation lost durable wake coverage")
        yield* clock.setTime(at!)
        yield* watchdog.alarm
      })
      const crash = Effect.gen(function* () {
        yield* store.close
        online = false
        version++
        entered = Deferred.makeUnsafe<void>()
        releaseSubmission = Deferred.makeUnsafe<void>()
        cleanupEntered = Deferred.makeUnsafe<void>()
        yield* wake
        assert.equal(online, true, "alarm did not reopen owed work")
        assert.equal(db.records().get(key)?.status, "pending", "execution death blocked surviving cleanup")
      })
      yield* Effect.gen(function* () {
        yield* Deferred.await(entered)
        const accepted = (yield* journalCall(() => journal.readInputs())).find(input => input.ref.act === Job.name)!
        childRef = (yield* journalCall(() => journal.readInputs())).find(input => input.ref.act === Child.name)?.ref
        assert.equal(accepted.request.input, scenario.input)
        yield* db.storage.transaction(tx => watchdog.admit(tx, target))
        yield* observe(accepted.ref)
        if (scenario.crash === "accepted") { yield* crash; yield* Deferred.await(entered) }
        if (scenario.finish !== "cancel") {
          yield* Deferred.succeed(releaseSubmission, undefined)
          yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.read())).then(records => recordedOperation(records, accepted.ref)?.execution.outcome), Boolean))
          const id = effectKey(accepted.ref)
          yield* Effect.promise(() => waitFor(() => service.job(id), job => job?.status === "running"))
          yield* crash
          assert.equal((yield* Effect.promise(() => service.job(id)))?.status, "running", "actor restart stopped external work")
          yield* Effect.promise(() => service.configure({ holdExecution: false }))
          yield* store.wait
          const remote = yield* Effect.promise(() => service.job(effectKey(accepted.ref)))
          assert.equal(remote?.executions, 1)
          assert.equal(remote?.submissions, 1)
          assert.equal(remote?.input, scenario.input)
          assert.equal(remote?.status, scenario.finish === "success" ? "completed" : "failed")
          assert.deepEqual(remote?.outputs, scenario.finish === "success" ? [scenario.input] : [])
          assert.equal((yield* journalCall(() => journal.readInputs())).length, 0)
          assert.ok(calls.every(call => call.input === scenario.input && effectKey(call.ref) === effectKey(accepted.ref)))
          yield* wake
          assert.equal(db.records().has(key), false)
          assert.equal(db.alarm(), null)
          yield* observe(accepted.ref)
          yield* store.checkpoint
          const count = calls.length
          const records = yield* journalCall(() => journal.read())
          yield* store.close
          version++
          store = yield* open()
          yield* store.wait
          assert.equal(calls.length, count)
          assert.deepEqual(yield* journalCall(() => journal.read()), records)
          return
        }
        yield* store.cancel(accepted.ref, "stop")
        yield* observe(accepted.ref)
        if (scenario.death) {
          yield* Deferred.succeed(die, undefined)
          yield* Effect.promise(() => waitFor(() => Promise.resolve(store.snapshot().defect), Boolean))
        }
        yield* Deferred.succeed(releaseSubmission, undefined)
        if (scenario.crash === "forwarding") { yield* Deferred.await(forwarding); yield* wake; yield* observe(accepted.ref); yield* crash }
        yield* Deferred.await(cleanupEntered)
        const cleanup = calls.find(call => call.kind === "cleanup" && call.ref.act === Job.name)!
        assert.equal(cleanup.handle, effectKey(accepted.ref), "late handle was discarded before cleanup")
        assert.equal((yield* journalCall(() => journal.readInputs())).some(input => effectKey(input.ref) === effectKey(accepted.ref)), true)
        if (scenario.crash === "retry") {
          yield* Effect.promise(() => waitFor(() => Promise.resolve(store.snapshot().retry(accepted.ref, "cancellation")), Boolean))
        }
        yield* wake
        assert.equal(db.records().get(key)?.status, "pending", "cleanup lost watchdog coverage")
        yield* observe(accepted.ref)
        if (scenario.crash !== "accepted" && scenario.crash !== "forwarding") { if (!scenario.death) assert.ok(Exit.isFailure(yield* Effect.exit(store.checkpoint)), "unfinished cleanup allowed checkpoint capture"); yield* crash; yield* Deferred.await(cleanupEntered); yield* observe(accepted.ref) }
        yield* Effect.promise(() => service.configure({ holdCancellationResponse: false }))
        yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.read())).then(records => recordedOperation(records, accepted.ref)?.cleanup?.outcome), Boolean))
        if (childRef) yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.read())).then(records => recordedOperation(records, childRef!)?.cleanup?.outcome), Boolean))
        const outcome = recordedOperation(yield* journalCall(() => journal.read()), accepted.ref)?.cleanup?.outcome
        assert.equal(outcome?.type, "CancellationSettled")
        if (outcome?.type === "CancellationSettled") assert.equal(outcome.outcome.status, "fulfilled")
        const jobs = yield* Effect.promise(() => service.jobs())
        assert.equal(jobs.length, scenario.forward ? 2 : 1)
        for (const job of jobs) {
          assert.equal(job.input, scenario.input)
          assert.ok(job.executions <= 1, "external job executed twice")
          assert.equal(job.status, "cancelled")
          assert.equal(job.cancellationAcknowledgements, 1)
          assert.equal(job.history.filter(event => event === "cancelled").length, 1)
          assert.deepEqual(job.outputs, [])
        }
        assert.equal((yield* journalCall(() => journal.readInputs())).some(input => effectKey(input.ref) === effectKey(accepted.ref)), false)
        assert.ok(calls.every(call => call.input === scenario.input && effectKey(call.ref) === effectKey(call.ref.act === Job.name ? accepted.ref : childRef!)))
        yield* wake
        if (scenario.death) assert.equal(db.records().get(key)?.status, "blocked", "execution death was hidden after cleanup completed")
        else assert.equal(db.records().has(key), false, "completed operation retained recovery coverage")
        assert.equal(db.alarm(), null)
        yield* observe(accepted.ref)
        if (!scenario.death) yield* store.checkpoint
        const records = yield* journalCall(() => journal.read())
        const count = calls.length
        yield* store.close
        version++
        store = yield* open()
        yield* Effect.exit(store.wait)
        assert.equal(calls.length, count, "completed work repeated after reopening")
        assert.deepEqual(yield* Effect.promise(() => service.jobs()), jobs)
        assert.deepEqual(yield* journalCall(() => journal.read()), records)
        assert.equal((yield* journalCall(() => journal.readInputs())).length, 0)
      }).pipe(Effect.ensuring(Effect.gen(function* () {
        yield* Deferred.succeed(releaseSubmission, undefined)
        yield* Effect.promise(() => service.configure({ holdCancellationResponse: false }))
        yield* Deferred.succeed(releaseForwarding, undefined)
        yield* store.close
      })))
    }).pipe(Effect.provideService(Clock.Clock, clock))
  }).pipe(Effect.scoped, Effect.timeout(5_000)))
}

// defaultAttemptDeadline observes a withheld HTTP response until the framework deadline reaches a retry decision (core/quint/attemptDeadline.qnt, timeoutStopsTest).
export async function defaultAttemptDeadline(journal: Journal<typeof Event.Type>, service: EffectServiceClient, phase: "execution" | "cleanup") {
  await service.configure({ ...DEFAULT_EFFECT_SERVICE_POLICY, runDurationMs: 0, holdExecution: phase === "cleanup", holdSubmissionResponse: phase === "execution", holdCancellationResponse: phase === "cleanup" })
  return Effect.runPromise(Effect.gen(function* () {
    const clock = yield* TestClock.make()
    return yield* Effect.gen(function* () {
      let decideCalls = 0
      const store = yield* createActorStore({
        actor: defineActor("unanswered", Effect.sync(() => {
          const job = Job.request({ input: "withheld-response", onSettled: completion.onSettled })
          return { schema: Event, atom: effectAtom(get => ({ view: null, events: {}, acts: get(completion.state).status === "pending" ? { job } : {} })) }
        })), journal, effectInput: { digestMinBytes: 0 }, checkpoint: { mode: "manual" }, actorContext: Context.pick(),
        cancellation: { decide: () => Effect.sync(() => { decideCalls++; return undefined }) },
        services: runtime => Layer.merge(Layer.succeed(Promises, effectServicePromises(service, runtime)), Job.layer((input, { ref }) => Effect.gen(function* () {
          const execution = yield* EffectExecution
          const request = Effect.tryPromise({ try: signal => service.submit(effectKey(ref), input, signal), catch: RuntimeError.from })
          return Job.defer(yield* execution.submit(execution.retry(request, { decide: () => Effect.sync(() => { decideCalls++; return undefined }) })))
        }).pipe(Effect.mapError(String)), { cancel: (_input, { ref }) => Effect.tryPromise({ try: signal => service.cancel(effectKey(ref), signal), catch: RuntimeError.from }) })),
      })
      return yield* Effect.gen(function* () {
        const context = yield* Effect.context<never>()
        const run = Effect.runPromiseWith(context)
        const inputs = yield* Effect.promise(() => waitFor(() => Effect.runPromiseWith(context)(journalCall(() => journal.readInputs())), inputs => inputs.length === 1))
        const ref = inputs[0]!.ref
        const id = effectKey(ref)
        yield* Effect.promise(() => waitFor(() => service.job(id), job => job?.status === (phase === "execution" ? "completed" : "running")))
        if (phase === "cleanup") {
          yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.read())).then(records => recordedOperation(records, ref)?.execution.outcome), Boolean))
          yield* store.cancel(ref, "stop")
          yield* Effect.promise(() => waitFor(() => service.job(id), job => job?.status === "cancelled"))
        }
        const db = memoryWatchdog()
        const target = { actor: "unanswered", instance: "main", thread: "one" }
        const key = watchdogKey(target)
        let recoveries = 0
        const watchdog = createWatchdog({ storage: db.storage,
          policy: { maxAttempts: 1, maxNoProgressAttempts: 1, attemptTimeoutMs: 1, keepAliveIntervalMs: 10 },
          probe: () => Effect.try({ try: () => store.recoveryState(), catch: RuntimeError.from }),
          recover: () => Effect.sync(() => { recoveries++; return store.recoveryState() }), invalidate: () => store.close,
        })
        yield* db.storage.transaction(tx => watchdog.admit(tx, target))
        for (let heartbeat = 0; heartbeat < 8; heartbeat++) {
          yield* clock.setTime(db.alarm()!)
          yield* watchdog.alarm
        }
        const remote = yield* Effect.promise(() => service.job(id))
        const report = {
          phase, externalStatus: remote!.status, executions: remote!.executions, outputs: remote!.outputs,
          cancellationAcknowledgements: remote!.cancellationAcknowledgements,
          runtimeStatus: store.recoveryState().status, decideCalls, retryRecords: store.snapshot().records.filter(({ event }) => event.type === "RetryScheduled").length,
          retainedInputs: (yield* journalCall(() => journal.readInputs())).length, watchdogAttempts: db.records().get(key)!.attempts,
          watchdogRecoveries: recoveries, elapsedVirtualMs: yield* Clock.currentTimeMillis,
        }
        assert.equal(report.runtimeStatus, "running")
        assert.equal(report.decideCalls, 0)
        assert.equal(report.retryRecords, 0)
        assert.equal(report.retainedInputs, 1)
        assert.equal(report.watchdogAttempts, 0)
        assert.equal(report.watchdogRecoveries, 0)
        assert.equal(report.executions, 1)
        assert.equal(store.snapshot().records.some(({ event }) => phase === "execution" ? event.type === "EffectSettled" : event.type === "CancellationSettled"), false)
        yield* clock.setTime(DEFAULT_ATTEMPT_TIMEOUT_MS - 1)
        assert.equal(decideCalls, 0)
        yield* clock.adjust(1)
        yield* Effect.promise(() => waitFor(() => Promise.resolve(decideCalls), count => count === 1))
        const outcome = () => run(journalCall(() => journal.read())).then(records => phase === "execution" ? recordedOperation(records, ref)?.execution.outcome : recordedOperation(records, ref)?.cleanup?.outcome)
        yield* Effect.promise(() => waitFor(outcome, Boolean))
        const final = (yield* Effect.promise(outcome))!
        assert.ok(final.type === "EffectSettled" || final.type === "CancellationSettled")
        assert.equal(final.outcome.status, "rejected")
        if (final.outcome.status === "rejected") assert.ok(String(final.outcome.reason).includes(`Attempt timed out after ${DEFAULT_ATTEMPT_TIMEOUT_MS}ms`))
        yield* Effect.promise(() => service.configure({ holdSubmissionResponse: false, holdCancellationResponse: false }))
        yield* Effect.exit(store.wait)
        assert.equal((yield* journalCall(() => journal.readInputs())).length, phase === "execution" ? 0 : 1)
        yield* watchdog.alarm
        assert.equal(db.records().get(key)?.status, phase === "cleanup" ? "blocked" : undefined)
        return report
      }).pipe(Effect.ensuring(Effect.promise(() => service.configure({ holdSubmissionResponse: false, holdCancellationResponse: false })).pipe(Effect.andThen(store.close))))
    }).pipe(Effect.provideService(Clock.Clock, clock))
  }).pipe(Effect.scoped))
}

export const attemptDeadlineCases = fc.record({ input: fc.string(), phase: fc.constantFrom("execution", "cleanup"), finish: fc.constantFrom("retry", "stop", "exhaust"), timeoutMs: fc.integer({ min: 1, max: 20 }), producerPending: fc.boolean() }).map(scenario => ({ ...scenario, producerPending: scenario.phase === "cleanup" && scenario.producerPending }))
type DeadlineScenario = typeof attemptDeadlineCases extends fc.Arbitrary<infer Value> ? Value : never

// attemptDeadlineLifecycle checks timeouts, durable retries, receiver deduplication, and final retention (core/quint/attemptDeadline.qnt, invariant).
export async function attemptDeadlineLifecycle(journal: Journal<typeof Event.Type>, service: EffectServiceClient, scenario: DeadlineScenario) {
  await service.configure({ ...DEFAULT_EFFECT_SERVICE_POLICY, runDurationMs: 0, holdExecution: scenario.phase === "cleanup", holdSubmissionResponse: scenario.phase === "execution" || scenario.producerPending, holdCancellationResponse: scenario.phase === "cleanup" })
  await Effect.runPromise(Effect.gen(function* () {
    const clock = yield* TestClock.make()
    yield* Effect.gen(function* () {
      const context = yield* Effect.context<never>()
      const run = Effect.runPromiseWith(context)
      let version = 0
      const decisions: { timeoutMs: number; attempt: number }[] = []
      const calls: { input: string; ref: EffectRef }[] = []
      const retry = {
        attemptTimeoutMs: scenario.timeoutMs,
        decide: (failure: Error, attempt: number) => Effect.sync(() => {
          assert.ok(Schema.is(AttemptTimedOut)(failure), "deadline must reach the typed failure channel")
          decisions.push({ timeoutMs: failure.timeoutMs, attempt })
          return scenario.finish !== "stop" && attempt === 0 ? { delayMs: scenario.timeoutMs + 10, reason: { type: failure._tag, timeoutMs: failure.timeoutMs } } : undefined
        }),
      }
      const open = () => createActorStore({
        actor: defineActor("deadline", Effect.sync(() => {
          const job = Job.request({ input: version === 0 ? scenario.input : "replacement proposal", onSettled: completion.onSettled })
          return { schema: Event, atom: effectAtom(get => ({ view: null, events: {}, acts: get(completion.state).status === "pending" ? { job } : {} })) }
        })), journal, effectInput: { digestMinBytes: 0 }, checkpoint: { mode: "manual" }, actorContext: Context.pick(),
        ...(scenario.phase === "cleanup" ? { cancellation: retry } : {}),
        services: runtime => Layer.merge(Layer.succeed(Promises, effectServicePromises(service, runtime)), Job.layer((input, { ref }) => Effect.gen(function* () {
          calls.push({ input, ref })
          const execution = yield* EffectExecution
          const request = Effect.tryPromise({ try: signal => service.submit(effectKey(ref), input, signal), catch: RuntimeError.from })
          return Job.defer(yield* execution.submit(scenario.phase === "execution" ? execution.retry(request, retry) : request))
        }).pipe(Effect.mapError(String)), { cancel: (input, { ref }) => Effect.gen(function* () {
          calls.push({ input, ref })
          yield* Effect.tryPromise({ try: signal => service.cancel(effectKey(ref), signal), catch: RuntimeError.from })
        }) })),
      })
      let store = yield* open()
      yield* Effect.gen(function* () {
        const inputs = yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.readInputs())), inputs => inputs.length === 1))
        const ref = inputs[0]!.ref
        const id = effectKey(ref)
        yield* Effect.promise(() => waitFor(() => service.job(id), job => job?.status === (scenario.phase === "execution" ? "completed" : "running")))
        if (scenario.phase === "cleanup") {
          if (!scenario.producerPending) yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.read())).then(records => recordedOperation(records, ref)?.execution.outcome), Boolean))
          yield* store.cancel(ref, "stop")
          if (!scenario.producerPending) yield* Effect.promise(() => waitFor(() => service.job(id), job => job?.status === "cancelled"))
        }
        yield* clock.adjust(scenario.timeoutMs)
        yield* Effect.promise(() => waitFor(() => Promise.resolve(decisions.length), count => count === 1))
        assert.deepEqual(decisions, [{ timeoutMs: scenario.timeoutMs, attempt: 0 }])
        if (scenario.finish !== "stop") {
          const phase = scenario.phase === "cleanup" ? "cancellation" : "execution"
          const scheduled = yield* Effect.promise(() => waitFor(() => Promise.resolve(store.snapshot().retry(ref, phase)), Boolean))
          assert.equal(scheduled!.attempt, 1)
          assert.deepEqual(scheduled!.reason, { type: "AttemptTimedOut", timeoutMs: scenario.timeoutMs })
          assert.equal((yield* journalCall(() => journal.readInputs())).length, 1, "retry lost original input")
          if (scenario.producerPending) {
            assert.equal((yield* Effect.promise(() => service.job(id)))?.cancellationRequests, 0, "cleanup ran before producer handoff")
            yield* Effect.promise(() => service.configure({ holdSubmissionResponse: false }))
            yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.read())).then(records => recordedOperation(records, ref)?.execution.outcome), Boolean))
          }
          const remote = yield* Effect.promise(() => service.job(id))
          if (scenario.phase === "cleanup") assert.ok(Exit.isFailure(yield* Effect.exit(store.checkpoint)), "cleanup retry allowed checkpoint capture")
          yield* store.close
          version++
          store = yield* open()
          assert.deepEqual(yield* Effect.promise(() => service.job(id)), remote, "reopen ran work before the recorded wake")
          assert.equal(store.snapshot().retry(ref, phase)?.dueAt, scheduled!.dueAt)
          if (scenario.finish === "retry") yield* Effect.promise(() => service.configure({ holdSubmissionResponse: false, holdCancellationResponse: false }))
          yield* clock.setTime(scheduled!.dueAt)
          yield* Effect.promise(() => waitFor(() => service.job(id), job => scenario.phase === "execution" ? job?.submissions === 2 : job?.cancellationRequests === (scenario.producerPending ? 1 : 2)))
          if (scenario.finish === "exhaust") {
            yield* clock.adjust(scenario.timeoutMs)
            yield* Effect.promise(() => waitFor(() => Promise.resolve(decisions.length), count => count === 2))
            assert.deepEqual(decisions, [{ timeoutMs: scenario.timeoutMs, attempt: 0 }, { timeoutMs: scenario.timeoutMs, attempt: 1 }])
          }
        }
        const outcome = () => run(journalCall(() => journal.read())).then(records => scenario.phase === "execution" ? recordedOperation(records, ref)?.execution.outcome : recordedOperation(records, ref)?.cleanup?.outcome)
        yield* Effect.promise(() => waitFor(outcome, Boolean))
        const final = (yield* Effect.promise(outcome))!
        assert.ok(final.type === "EffectSettled" || final.type === "CancellationSettled", "timeout was recorded as a defect")
        assert.equal(final.outcome.status, scenario.finish === "retry" ? "fulfilled" : "rejected")
        if (final.outcome.status === "rejected") assert.ok(String(final.outcome.reason).includes(`Attempt timed out after ${scenario.timeoutMs}ms`))
        if (scenario.producerPending && scenario.finish === "stop") {
          yield* Effect.promise(() => service.configure({ holdSubmissionResponse: false }))
          yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.read())).then(records => recordedOperation(records, ref)?.execution.outcome), Boolean))
          assert.equal((yield* Effect.promise(() => service.job(id)))?.cancellationRequests, 0)
        }
        const retained = scenario.phase === "cleanup" && scenario.finish !== "retry"
        yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.readInputs())), inputs => inputs.length === (retained ? 1 : 0)))
        if (retained) assert.equal((yield* journalCall(() => journal.readInputs()))[0]!.request.input, scenario.input)
        const remote = yield* Effect.promise(() => service.job(id))
        assert.equal(remote?.executions, 1)
        assert.equal(remote?.input, scenario.input)
        assert.deepEqual(remote?.outputs, scenario.phase === "execution" ? [scenario.input] : [])
        assert.equal(remote?.cancellationAcknowledgements, scenario.phase === "cleanup" && !(scenario.producerPending && scenario.finish === "stop") ? 1 : 0)
        assert.equal((yield* Effect.promise(() => service.jobs())).length, 1)
        assert.ok(calls.every(call => call.input === scenario.input && effectKey(call.ref) === id))
        if (scenario.finish === "stop") assert.equal(store.snapshot().records.filter(({ event }) => event.type === "RetryScheduled").length, 0)
        if (retained) assert.ok(Exit.isFailure(yield* Effect.exit(store.checkpoint)), "failed cleanup allowed checkpoint capture")
        else yield* store.checkpoint
        yield* store.close
        version++
        const count = calls.length
        store = yield* open()
        yield* Effect.exit(store.wait)
        assert.equal(calls.length, count, "terminal work repeated after recovery")
        assert.deepEqual(yield* Effect.promise(() => service.job(id)), remote)
        assert.equal((yield* journalCall(() => journal.readInputs())).length, retained ? 1 : 0)
      }).pipe(Effect.ensuring(Effect.promise(() => service.configure({ holdSubmissionResponse: false, holdCancellationResponse: false })).pipe(Effect.andThen(Effect.suspend(() => store.close)))))
    }).pipe(Effect.provideService(Clock.Clock, clock))
  }).pipe(Effect.scoped))
}

export const streamDeadlineCases = fc.record({ input: fc.string(), bound: fc.constantFrom("firstChunkMs", "idleMs"), timeoutMs: fc.integer({ min: 1, max: 20 }), intervalMs: fc.integer({ min: 0, max: 3 }) })
type StreamScenario = typeof streamDeadlineCases extends fc.Arbitrary<infer Value> ? Value : never

// streamDeadlineLifecycle checks transport interruption and durable retry against independently produced HTTP chunks (platform/test/bun/execution-stream.test.ts).
export async function streamDeadlineLifecycle(journal: Journal<typeof Event.Type>, service: EffectServiceClient, scenario: StreamScenario) {
  let stage = "opening the source"
  const prefix = scenario.bound === "idleMs" ? 1 : 0
  await service.configure({ ...DEFAULT_EFFECT_SERVICE_POLICY, runDurationMs: 0, holdStreamResponse: true, holdStreamAfter: prefix, streamChunkIntervalMs: scenario.intervalMs })
  await Effect.runPromise(Effect.gen(function* () {
    const clock = yield* TestClock.make()
    yield* Effect.gen(function* () {
      const context = yield* Effect.context<never>()
      const run = Effect.runPromiseWith(context)
      let version = 0
      const received: { index: number; input: string }[][] = []
      const open = () => createActorStore({ actor: defineActor("stream-deadline", Effect.sync(() => {
        const request = Job.request({ input: version === 0 ? scenario.input : "replacement proposal", onSettled: completion.onSettled })
        return { schema: Event, atom: effectAtom(get => ({ view: get(completion.state), events: {}, acts: get(completion.state).status === "pending" ? { job: request } : {} })) }
      })), journal, checkpoint: { mode: "manual" }, effectInput: { digestMinBytes: 0 }, actorContext: Context.pick(), services: () => Job.layer((input, { ref }) => Effect.gen(function* () {
        const execution = yield* EffectExecution
        const work = Effect.gen(function* () {
          const chunks: { index: number; input: string }[] = []
          received.push(chunks)
          yield* Effect.tryPromise({ try: signal => service.submit(effectKey(ref), input, signal), catch: RuntimeError.from })
          const stream = Stream.unwrap(Effect.tryPromise({ try: signal => service.stream(effectKey(ref), signal), catch: RuntimeError.from }).pipe(Effect.map(body => Stream.fromReadableStream({ evaluate: () => body, onError: RuntimeError.from }))))
          yield* withStreamTimeout(stream, { firstChunkMs: scenario.timeoutMs, idleMs: scenario.timeoutMs }).pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(line => Effect.sync(() => { chunks.push(JSON.parse(line) as { index: number; input: string }) })))
          return input
        })
        return yield* execution.retry(work, { attemptTimeoutMs: scenario.timeoutMs * 10, decide: (failure, attempt) => Effect.sync(() => {
          assert.ok(failure instanceof StreamTimedOut)
          assert.equal(failure.bound, scenario.bound)
          assert.equal(failure.timeoutMs, scenario.timeoutMs)
          assert.equal(attempt, 0)
          return { delayMs: scenario.timeoutMs + 10, reason: { type: failure._tag, bound: failure.bound, timeoutMs: failure.timeoutMs } }
        }) })
      }).pipe(Effect.mapError(String))) })
      let store = yield* open()
      yield* Effect.gen(function* () {
        const inputs = yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.readInputs())), inputs => inputs.length === 1))
        const ref = inputs[0]!.ref
        const id = effectKey(ref)
        yield* Effect.promise(() => waitFor(() => service.job(id), job => job?.history.includes("stream_opened") === true))
        if (prefix) yield* Effect.promise(() => waitFor(() => Promise.resolve(received[0]?.length), count => count === prefix))
        yield* clock.adjust(scenario.timeoutMs)
        stage = "recording the stream timeout"
        const scheduled = yield* Effect.promise(() => waitFor(() => Promise.resolve(store.snapshot().retry(ref)), Boolean))
        assert.equal(scheduled!.attempt, 1)
        assert.deepEqual(scheduled!.reason, { type: "StreamTimedOut", bound: scenario.bound, timeoutMs: scenario.timeoutMs })
        assert.equal((yield* journalCall(() => journal.readInputs())).length, 1)
        assert.equal(store.snapshot().effect(ref)?.execution.outcome, undefined, "partial stream settled the effect")
        assert.equal(received[0]!.length, prefix)
        stage = "releasing the timed-out producer"
        yield* Effect.promise(() => service.configure({ holdStreamResponse: false }))
        assert.equal(received[0]!.length, prefix, "late transport chunks reached a completed attempt")
        yield* store.close
        version++
        store = yield* open()
        assert.equal(received.length, 1, "stream restarted before its durable wake")
        yield* clock.setTime(scheduled!.dueAt)
        stage = "collecting the recovered stream"
        yield* store.wait
        assert.deepEqual(store.getState().view, { status: "fulfilled", value: scenario.input })
        assert.deepEqual(received[1], Array.from({ length: DEFAULT_EFFECT_SERVICE_POLICY.streamChunks }, (_, index) => ({ index, input: scenario.input })))
        const remote = yield* Effect.promise(() => service.job(id))
        assert.equal(remote?.submissions, 2)
        assert.equal(remote?.executions, 1)
        assert.deepEqual(remote?.outputs, [scenario.input])
        assert.equal(remote?.history.filter(event => event === "stream_opened").length, 2)
        assert.ok(remote!.history.filter(event => event === "stream_closed").length >= 1)
        const sent = remote!.history.filter(event => event === "stream_chunk").length
        assert.ok(sent >= prefix + DEFAULT_EFFECT_SERVICE_POLICY.streamChunks && sent <= 2 * DEFAULT_EFFECT_SERVICE_POLICY.streamChunks)
        assert.equal(received[0]!.length, prefix)
        assert.equal((yield* journalCall(() => journal.readInputs())).length, 0)
      }).pipe(Effect.ensuring(Effect.promise(() => service.configure({ holdStreamResponse: false })).pipe(Effect.andThen(Effect.suspend(() => store.close)))))
    }).pipe(Effect.provideService(Clock.Clock, clock))
  }).pipe(Effect.scoped)).catch(error => { throw new Error(`Stream lifecycle failed while ${stage}`, { cause: error }) })
}

export const operationRaceCases = (["cancel-handle", "handle-cancel", "deadline-cancel", "cancel-deadline", "cleanup-cancel"] as const).flatMap(order => (["none", "rollback", "ack-lost"] as const).map(fault => ({ order, fault })))
type RaceScenario = typeof operationRaceCases[number]

// operationRace preserves committed history, original input, and external identity across admission races and SQLite rollback (core/quint/operationRecovery.qnt, retained, cleanupComplete).
export async function operationRace(journal: Journal<typeof Event.Type>, service: EffectServiceClient, execute: (query: string) => Promise<unknown>, scenario: RaceScenario) {
  await service.configure({ ...DEFAULT_EFFECT_SERVICE_POLICY, holdExecution: true, holdSubmissionResponse: true, cancelDelayMs: 0 })
  await Effect.runPromise(Effect.gen(function* () {
    const clock = yield* TestClock.make()
    yield* Effect.gen(function* () {
      const context = yield* Effect.context<never>()
      const run = Effect.runPromiseWith(context)
      const timeoutMs = 10
      const original = `accepted-${scenario.order}`.repeat(128)
      const gateType = scenario.order.startsWith("cancel-") ? "EffectCancelled" : scenario.order === "handle-cancel" ? "EffectSettled" : scenario.order === "deadline-cancel" ? "RetryScheduled" : "CancellationSettled"
      const staged = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      const finished = Deferred.makeUnsafe<Exit.Exit<void, Error>>()
      const returned = Deferred.makeUnsafe<void>()
      const handoff = Deferred.makeUnsafe<void>()
      let armed = true
      let version = 0
      let handedOffAt: number | undefined
      let before: readonly Recorded<typeof Event.Type>[] = []
      let stagedBatch: readonly Recorded<typeof Event.Type>[] = []
      const calls: { input: string; ref: EffectRef; kind: "execution" | "cleanup"; handle?: string }[] = []
      let awaitingCommit: Exit.Exit<void, Error> | undefined
      const barrier = (batch: readonly Recorded<typeof Event.Type>[], write: () => undefined): undefined => {
        if (!armed || !batch.some(({ event }) => event.type === gateType)) return write()
        armed = false
        before = journal.read()
        stagedBatch = batch
        const result = Effect.runSyncExit(journalCall(write))
        Deferred.doneUnsafe(staged, Effect.void)
        if (Exit.isFailure(result)) {
          Deferred.doneUnsafe(finished, Effect.succeed(result))
          throw Cause.squash(result.cause)
        }
        awaitingCommit = result
      }
      const gated: Journal<typeof Event.Type> = { ...journal,
        append: (position, batch, inputs) => barrier(batch, () => journal.append(position, batch, inputs)),
        appendWithCheckpoint: (position, batch, checkpoint, inputs) => barrier(batch, () => journal.appendWithCheckpoint(position, batch, checkpoint, inputs)),
        acknowledge: write => journalCall(() => { write?.() }).pipe(Effect.andThen(Effect.suspend(() => {
          if (!awaitingCommit) return journal.acknowledge?.() ?? Effect.void
          awaitingCommit = undefined
          return Effect.gen(function* () {
            yield* Deferred.await(release)
            const result = yield* Effect.exit((journal.acknowledge?.() ?? Effect.void).pipe(Effect.andThen(scenario.fault === "ack-lost" ? Effect.fail(new RuntimeError("Lost commit acknowledgement")) : Effect.void)))
            yield* Deferred.succeed(finished, result)
            if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
          })
        }))),
      }
      const open = () => createActorStore({
        actor: defineActor("operation-race", Effect.sync(() => {
          const job = Job.request({ input: version === 0 ? original : "replacement proposal", onSettled: completion.onSettled })
          return { schema: Event, atom: effectAtom(get => ({ view: get(completion.state), events: {}, acts: get(completion.state).status === "pending" ? { job } : {} })) }
        })), journal: gated, effectInput: { digestMinBytes: 0 }, checkpoint: { mode: "manual" }, actorContext: Context.pick(), cancellation: { attemptTimeoutMs: timeoutMs },
        services: () => Layer.merge(Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }), Job.layer((input, { ref }) => Effect.gen(function* () {
          calls.push({ kind: "execution", input, ref })
          const execution = yield* EffectExecution
          const request = Effect.tryPromise({ try: signal => service.submit(effectKey(ref), input, signal), catch: RuntimeError.from }).pipe(
            Effect.tap(() => version === 0 ? Deferred.succeed(returned, undefined).pipe(Effect.andThen(Deferred.await(handoff)), Effect.andThen(Clock.currentTimeMillis), Effect.tap(at => Effect.sync(() => { handedOffAt = at }))) : Effect.void),
          )
          return Job.defer(yield* execution.submit(execution.retry(request, { attemptTimeoutMs: timeoutMs, decide: (failure, attempt) => Effect.sync(() => {
            assert.ok(Schema.is(AttemptTimedOut)(failure))
            assert.equal(attempt, 0)
            return { delayMs: 2 * timeoutMs, reason: { type: failure._tag, timeoutMs: failure.timeoutMs } }
          }) })))
        }).pipe(Effect.mapError(String)), { cancel: (input, { ref, handle }) => Effect.gen(function* () {
          calls.push({ kind: "cleanup", input, ref, ...(handle ? { handle: handle.id } : {}) })
          yield* Effect.tryPromise({ try: signal => service.cancel(effectKey(ref), signal), catch: RuntimeError.from })
        }) })),
      })
      const releaseAtDeadline = Effect.sleep(timeoutMs).pipe(Effect.andThen(Deferred.succeed(handoff, undefined)), Effect.forkChild({ startImmediately: true }))
      if (scenario.order === "handle-cancel" || scenario.order === "cancel-handle") yield* releaseAtDeadline
      if (scenario.order === "cleanup-cancel") yield* Deferred.succeed(handoff, undefined)
      let store = yield* open()
      yield* Effect.gen(function* () {
        const inputs = yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.readInputs())), inputs => inputs.length === 1))
        const ref = inputs[0]!.ref
        const id = effectKey(ref)
        yield* Effect.promise(() => waitFor(() => service.job(id), job => job?.status === "running"))
        if (scenario.fault === "rollback") {
          const trigger = gateType === "CancellationSettled"
            ? "CREATE TRIGGER fail_race_commit BEFORE DELETE ON effect_inputs BEGIN SELECT RAISE(ABORT, 'Injected race failure'); END"
            : `CREATE TRIGGER fail_race_commit AFTER INSERT ON experimental_events WHEN json_extract(NEW.event, '$.event.type') = '${gateType}' BEGIN SELECT RAISE(ABORT, 'Injected race failure'); END`
          yield* Effect.promise(() => execute(trigger))
        }
        const cancel = () => store.cancel(ref, "stop").pipe(Effect.exit, Effect.forkChild)
        const releaseResponse = Effect.promise(() => service.configure({ holdSubmissionResponse: false }))
        let cancellation: Fiber.Fiber<Exit.Exit<void, Error>>
        if (scenario.order === "handle-cancel" || scenario.order === "cleanup-cancel") {
          yield* releaseResponse
          if (scenario.order === "cleanup-cancel") {
            yield* Effect.promise(() => waitFor(() => run(journalCall(() => journal.read())).then(records => recordedOperation(records, ref)?.execution.outcome), Boolean))
            yield* store.cancel(ref, "stop")
          } else {
            yield* Deferred.await(returned)
            yield* clock.adjust(timeoutMs)
          }
          yield* Deferred.await(staged)
          cancellation = yield* cancel()
          if (scenario.order === "cleanup-cancel") yield* clock.adjust(timeoutMs)
        } else if (scenario.order === "deadline-cancel") {
          yield* releaseResponse
          yield* Deferred.await(returned)
          yield* releaseAtDeadline
          yield* clock.adjust(timeoutMs)
          yield* Deferred.await(staged)
          cancellation = yield* cancel()
        } else {
          cancellation = yield* cancel()
          yield* Deferred.await(staged)
          yield* releaseResponse
          yield* Deferred.await(returned)
          if (scenario.order === "cancel-deadline") yield* releaseAtDeadline
          yield* clock.adjust(timeoutMs)
        }
        assert.equal(yield* Clock.currentTimeMillis, timeoutMs)
        assert.equal(handedOffAt, scenario.order.includes("deadline") ? undefined : scenario.order === "cleanup-cancel" ? 0 : timeoutMs)
        assert.deepEqual(yield* journalCall(() => journal.read()), scenario.fault === "rollback" ? before : [...before, ...stagedBatch], "synchronous transaction exposed a partial batch")
        const heldInputs = yield* journalCall(() => journal.readInputs())
        if (gateType === "CancellationSettled" && scenario.fault !== "rollback") assert.equal(heldInputs.length, 0)
        else assert.equal(heldInputs[0]!.request.input, original, "unfinished work lost its accepted input")
        yield* Deferred.succeed(release, undefined)
        const write = yield* Deferred.await(finished)
        const cancellationResult = yield* Fiber.join(cancellation)
        assert.equal(Exit.isFailure(write), scenario.fault !== "none")
        assert.equal(Exit.isFailure(cancellationResult), scenario.fault !== "none")
        if (scenario.fault !== "none") {
          const durable = yield* journalCall(() => journal.read())
          const inputs = yield* journalCall(() => journal.readInputs())
          if (scenario.fault === "rollback") assert.deepEqual(durable, before, "failed transaction changed the committed prefix")
          else {
            assert.deepEqual(durable, [...before, ...stagedBatch], "lost acknowledgement changed the committed batch")
            assert.equal(durable[before.length]!.event.type, gateType)
          }
          assert.deepEqual([...store.snapshot().records], before, "failed acknowledgement published volatile state")
          if (scenario.fault === "ack-lost" && gateType === "CancellationSettled") assert.equal(inputs.length, 0)
          else assert.equal(inputs[0]!.request.input, original, "failed transaction corrupted input chunks")
          assert.throws(() => store.recoveryState(), ActorCommitError)
          const failure = yield* Effect.exit(store.wait)
          assert.ok(Exit.isFailure(failure) && Cause.pretty(failure.cause).includes(scenario.fault === "rollback" ? "Injected race failure" : "Lost commit acknowledgement"))
          yield* Effect.promise(() => execute("DROP TRIGGER IF EXISTS fail_race_commit"))
          yield* store.close
          version++
          store = yield* open()
          if (!durable.some(({ event }) => event.type === "EffectCancelled")) yield* store.cancel(ref, "stop after recovery")
        }
        yield* store.wait
        const records = yield* journalCall(() => journal.read())
        assert.equal(records.filter(({ event }) => event.type === "EffectRequested").length, 1)
        assert.equal(records.filter(({ event }) => event.type === "CancellationSettled").length, 1)
        assert.equal(records.filter(({ event }) => event.type === "EffectDied" || event.type === "CancellationDied").length, 0)
        assert.ok(records.filter(({ event }) => event.type === "EffectSettled").length <= 1)
        const cancelledAt = records.findIndex(({ event }) => event.type === "EffectCancelled")
        assert.ok(cancelledAt >= 0)
        assert.equal(records.slice(cancelledAt + 1).some(({ event }) => event.type === "RetryScheduled" && event.phase !== "cancellation"), false, "cancelled execution scheduled another attempt")
        assert.deepEqual(store.getState().view, { status: "rejected", reason: { _tag: "Cancelled", reason: recordedOperation(records, ref)!.cleanup!.request.reason } })
        assert.deepEqual(Object.keys(store.getState().acts), [], "cancelled invocation remained proposed")
        if (scenario.fault === "none") {
          const timeoutWon = scenario.order.includes("deadline")
          assert.equal(records.filter(({ event }) => event.type === "EffectSettled").length, timeoutWon ? 0 : 1)
          assert.equal(records.filter(({ event }) => event.type === "RetryScheduled").length, scenario.order === "deadline-cancel" ? 1 : 0)
          assert.equal(calls.find(call => call.kind === "cleanup")?.handle, timeoutWon ? undefined : id)
        }
        assert.equal((yield* journalCall(() => journal.readInputs())).length, 0)
        const remote = yield* Effect.promise(() => service.job(id))
        assert.equal(remote?.executions, 1)
        assert.equal(remote?.input, original)
        assert.equal(remote?.status, "cancelled")
        assert.equal(remote?.cancellationAcknowledgements, 1)
        assert.deepEqual(remote?.outputs, [])
        assert.ok(calls.every(call => call.input === original && effectKey(call.ref) === id))
        yield* store.checkpoint
        const checkpoint = yield* journalCall(() => journal.readCheckpoint())
        assert.ok(checkpoint && !new TextDecoder().decode(checkpoint.payload).includes(original))
        yield* store.close
        version++
        const count = calls.length
        store = yield* open()
        yield* store.wait
        assert.equal(calls.length, count, "acknowledged operation repeated after recovery")
        assert.deepEqual(yield* Effect.promise(() => service.job(id)), remote)
      }).pipe(Effect.ensuring(Effect.gen(function* () {
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.succeed(handoff, undefined)
        yield* Effect.promise(() => service.configure({ holdSubmissionResponse: false, holdCancellationResponse: false }))
        yield* store.close
        yield* Effect.promise(() => execute("DROP TRIGGER IF EXISTS fail_race_commit"))
      })))
    }).pipe(Effect.provideService(Clock.Clock, clock))
  }).pipe(Effect.scoped))
}
