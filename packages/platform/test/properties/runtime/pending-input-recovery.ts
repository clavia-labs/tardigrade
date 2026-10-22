import { journalCommit } from "@clavia/tardigrade-core"
import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Promises } from "../../../../core/src/services/promises"
import { waitFor } from "../../fixtures/wait"
import { isDeepStrictEqual } from "node:util"
import { act, createActorStore, defineActor, durableAtom, effectAtom, EffectExecution, Scheduler, checkpointDigest, type EffectCheckpoint, effectKey, RuntimeError, ActorCommitError, ActorReplayError, type StoredOperation, type EffectRef, type Journal } from "@clavia/tardigrade-core"

const Finished = Schema.Struct({ type: Schema.Literal("Finished") })
type Event = typeof Finished.Type
const Job = act({ name: "test.accepted-input", input: Schema.String, success: Schema.String, failure: Schema.String })
const original = "accepted-v1".repeat(1_024)
const actor = (input: string) => defineActor("accepted-input", Effect.sync(() => {
  const done = durableAtom({ name: "accepted-input.done", input: Finished, schema: Schema.Boolean, initial: false, reduce: () => true })
  const request = Job.request({ input, onSettled: () => [{ type: "Finished" }] })
  return { schema: Finished, atom: effectAtom(get => ({ view: get(done), events: {}, acts: get(done) ? {} : { job: request } })) }
}))

async function writeLegacyCheckpoint(journal: Journal<Event>, checkpoint: EffectCheckpoint, operations: readonly StoredOperation[] = [], version: 2 | 3 = 2) {
  const legacy = { version: 2, position: checkpoint.position, durable: checkpoint.durable,
    effects: operations.map(operation => ({ ref: operation.ref, request: operation.request,
      ...(operation.execution.outcome?.type === "EffectSettled" ? { settlement: operation.execution.outcome } : {}),
      ...(operation.cleanup ? { cancellation: operation.cleanup.request } : {}),
    })), promises: operations.flatMap(operation => operation.execution.promise ?? []),
  }
  const payload = new TextEncoder().encode(JSON.stringify(version === 2 ? legacy : { version: 3, ...checkpoint, operations }))
  const digest = await Effect.runPromise(checkpointDigest(payload))
  await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(checkpoint.position, [], { position: checkpoint.position, payload, digest })))
}

// pendingInputRecovery preserves accepted input and reference across runtime changes and local deferred recovery (quint/checkpoint/inputLifecycle.qnt, verifiedExecution, inputRetained).
export async function pendingInputRecovery(fixture: { readonly open: (name: string) => Journal<Event> & { readonly close: Effect.Effect<void, Error> } }, legacy = false) {
  let journal = fixture.open(legacy ? "legacy-input" : "accepted-input")
  const attempts: { input: string; ref: EffectRef; runtime: number }[] = []
  const blocked = Deferred.makeUnsafe<void>()
  const entered = Deferred.makeUnsafe<void>()
  const open = (proposed: string, runtime: number) => Effect.runPromise(createActorStore({
    actor: actor(proposed), journal, effectInput: { digestMinBytes: 0 }, checkpoint: { mode: "manual" }, actorContext: Context.pick(),
    services: () => Job.layer((input, { ref }) => Effect.gen(function* () {
      attempts.push({ input, ref, runtime })
      if (runtime === 1) { yield* Deferred.succeed(entered, undefined); return yield* Effect.never }
      if (runtime === 2) {
        const execution = yield* EffectExecution
        return Job.defer(yield* execution.fork(Deferred.await(blocked).pipe(Effect.as([]))))
      }
      return `runtime-${runtime}`
    }).pipe(Effect.mapError(String))),
  }))
  let store = await open(original, 1)
  try {
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout(1_000)))
    const accepted = journal.readInputs()[0]
    if (!accepted || accepted.request.input !== original) throw new Error("Acceptance did not persist its input")
    const ref = accepted.ref
    await Effect.runPromise(store.close)
    if (legacy) {
      await Effect.runPromise(journalCommit(journal, () => journal.append(store.snapshot().position, [], { remove: [ref] })))
      const incompatible = await Effect.runPromise(Effect.exit(Effect.tryPromise({ try: () => open("changed", 2), catch: RuntimeError.from })))
      if (Exit.isSuccess(incompatible)) throw new Error("Legacy divergence was silently accepted")
      const error = Cause.squash(incompatible.cause)
      if (!(error instanceof ActorReplayError) || error.stage !== "retained_input" || error.reason !== "unavailable") throw new Error("Missing retained input has no structured classification")
    }
    await Effect.runPromise(journal.close)
    journal = fixture.open(legacy ? "legacy-input" : "accepted-input")
    store = await open(legacy ? original : "changed-v2", 2)
    await waitFor(async () => journal.read(), records => records.some(record => record.event.type === "EffectSettled"))
    if (journal.readInputs().length !== 1) throw new Error("Deferred work released its accepted input")
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = fixture.open(legacy ? "legacy-input" : "accepted-input")
    store = await open("changed-v3", 3)
    await Effect.runPromise(store.wait)
    if (attempts.length !== 3 || attempts.some(attempt => attempt.input !== original || effectKey(attempt.ref) !== effectKey(ref))) throw new Error("Recovery changed accepted input or reference")
    if (!isDeepStrictEqual(attempts.map(attempt => attempt.runtime), [1, 2, 3])) throw new Error("Recovery did not use current services")
    if (journal.readInputs().length || store.getState().view !== true) throw new Error("Terminal settlement retained input or lost its follow-up")
    const records = journal.read()
    await writeLegacyCheckpoint(journal, store.snapshot().checkpoint()!)
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = fixture.open(legacy ? "legacy-input" : "accepted-input")
    store = await open("changed-v4", 4)
    await Effect.runPromise(store.wait)
    if (attempts.length !== 3 || !isDeepStrictEqual(journal.read(), records)) throw new Error("Settled recovery executed or rewrote history")
  } finally { await Effect.runPromise(store.close); await Effect.runPromise(journal.close) }
}

interface CleanupFixture {
  readonly open: (name: string) => Journal<Event> & { readonly close: Effect.Effect<void, Error> }
  readonly execute: (name: string, query: string) => Promise<unknown>
}

// cancellationInputRecovery checks acknowledgement, producer quiescence, checkpoint recovery, and atomic payload release (core/tla/InputRetention.tla, DurableSerializedSafety, RecoveryStability).
export async function cancellationInputRecovery(fixture: CleanupFixture, legacyVersion: 2 | 3 = 2) {
  const name = `cancellation-input-${legacyVersion}`
  let journal = fixture.open(name)
  const entered = Deferred.makeUnsafe<void>()
  const releaseSubmission = Deferred.makeUnsafe<void>()
  const cleanupEntered = Deferred.makeUnsafe<void>()
  const blockCleanup = Deferred.makeUnsafe<void>()
  let executions = 0
  let cleanups = 0
  let forbidHistory = false
  let operationReads = 0
  const open = (version: number) => Effect.runPromise(createActorStore({
    actor: actor(version === 1 ? original : `changed-${version}`), journal: {
      ...journal,
      read: () => { if (forbidHistory) throw new RuntimeError("Late delivery read the entire journal"); return journal.read() },
      readOperation: (ref, position) => { operationReads++; return journal.readOperation(ref, position) },
    }, effectInput: { digestMinBytes: 0 }, checkpoint: { mode: "manual" },
    cancellation: { retryIntervalMs: 1 }, actorContext: Context.pick(),
    services: () => Job.layer(() => Effect.gen(function* () {
      executions++
      const execution = yield* EffectExecution
      return Job.defer(yield* execution.submit(Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseSubmission)), Effect.as({ executor: "remote", id: "late-handle" }),
      )))
    }).pipe(Effect.mapError(String)), { cancel: (input, { handle }) => Effect.gen(function* () {
      cleanups++
      if (input !== original || handle?.id !== "late-handle") return yield* Effect.die("Cleanup lost the accepted input or late handle")
      if (version === 1 && cleanups === 1) return yield* Effect.fail(new RuntimeError("Retry cleanup"))
      if (version === 2) { yield* Deferred.succeed(cleanupEntered, undefined); yield* Deferred.await(blockCleanup) }
    }) }),
  }))
  let store = await open(1)
  try {
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout(1_000)))
    const pending = journal.readInputs()[0]!
    await fixture.execute(name, "CREATE TRIGGER fail_cleanup_release BEFORE DELETE ON effect_inputs BEGIN SELECT RAISE(ABORT, 'Injected cleanup release failure'); END")
    await Effect.runPromise(store.cancel(pending.ref, "stop"))
    if (Number(cleanups) !== 0 || journal.readInputs().length !== 1) throw new Error("Cleanup acknowledged before the producer stopped")
    await Effect.runPromise(Deferred.succeed(releaseSubmission, undefined))
    const failed = await Effect.runPromise(Effect.exit(store.wait))
    if (Exit.isSuccess(failed) || !Cause.pretty(failed.cause).includes("Injected cleanup release failure")) throw new Error("Cleanup release failure was not reported")
    const recovery = await Effect.runPromise(Effect.exit(Effect.try({ try: () => store.recoveryState(), catch: RuntimeError.from })))
    if (Exit.isSuccess(recovery) || !Cause.pretty(recovery.cause).includes("Actor state could not be persisted")) throw new Error("Cleanup concealed a failed journal commit from recovery")
    const retry = journal.read().find(record => record.event.type === "RetryScheduled")?.event
    if (retry?.type !== "RetryScheduled" || retry.phase !== "cancellation" || retry.attempt !== 1 || retry.reason !== "Retry cleanup") throw new Error("Cleanup retry did not record its decision")
    if (Number(cleanups) !== 2 || journal.readInputs().length !== 1
      || journal.read().some(record => record.event.type === "CancellationSettled")) throw new Error("Failed release committed a partial acknowledgement")
    await fixture.execute(name, "DROP TRIGGER fail_cleanup_release")
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = fixture.open(name)
    store = await open(2)
    await Effect.runPromise(Deferred.await(cleanupEntered).pipe(Effect.timeout(1_000)))
    if (store.snapshot().checkpoint() !== undefined || Exit.isSuccess(await Effect.runPromise(Effect.exit(store.checkpoint)))) throw new Error("Unfinished cleanup allowed checkpoint capture")
    await writeLegacyCheckpoint(journal, { position: store.snapshot().position, durable: [{ name: "accepted-input.done", state: store.getState().view, position: store.snapshot().position }] }, [store.snapshot().effect(pending.ref)!], legacyVersion)
    await Effect.runPromise(store.close)
    if (journal.readInputs().length !== 1) throw new Error("Interrupted cleanup released its input")
    await Effect.runPromise(journal.close)
    journal = fixture.open(name)
    store = await open(3)
    await Effect.runPromise(store.wait)
    const records = journal.read()
    if (executions !== 1 || Number(cleanups) !== 4 || records.filter(record => record.event.type === "CancellationSettled").length !== 1
      || journal.readInputs().length !== 0) throw new Error("Cleanup acknowledgement did not release input exactly once")
    await Effect.runPromise(store.checkpoint)
    const checkpoint = journal.readCheckpoint()
    if (!checkpoint || new TextDecoder().decode(checkpoint.payload).includes(original)) throw new Error("Acknowledged checkpoint retained the full input")
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = fixture.open(name)
    store = await open(4)
    forbidHistory = true
    operationReads = 0
    await Effect.runPromise(store.cancel(pending.ref, "duplicate"))
    await Effect.runPromise(store.wait)
    if (operationReads !== 1 || Number(cleanups) !== 4 || executions !== 1 || !isDeepStrictEqual(journal.read(), records)) throw new Error("Acknowledged cleanup repeated or scanned history after checkpoint recovery")
  } finally {
    await Effect.runPromise(Deferred.succeed(releaseSubmission, undefined))
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
  }
}

// stoppedInputRecovery retains possible forwarding inputs until cancellation cleanup finishes across thread death (core/tla/InputRetention.tla, StopPreservesCleanup).
export async function stoppedInputRecovery(fixture: CleanupFixture, failCleanupCommit = false) {
  const name = failCleanupCommit ? "stopped-input-commit-failure" : "stopped-input"
  let journal = fixture.open(name)
  const die = Deferred.makeUnsafe<void>()
  const cleanupEntered = Deferred.makeUnsafe<void>()
  const releaseCleanup = Deferred.makeUnsafe<void>()
  const Dying = act({ name: "test.stopped-input", input: Schema.String, success: Schema.String, failure: Schema.String })
  let executions = 0
  let cleanups = 0
  const open = (version: number) => Effect.runPromise(createActorStore({
    actor: defineActor(name, Effect.sync(() => {
      const input = version === 1 ? original : "changed"
      const job = Job.request({ input })
      const dying = Dying.request({ input })
      return { schema: Finished, atom: effectAtom(() => ({ view: null, events: {}, acts: { job, dying } })) }
    })), journal, checkpoint: { mode: "manual" }, effectInput: { digestMinBytes: 0 }, actorContext: Context.pick(),
    services: () => Layer.merge(Job.layer(() => Effect.sync(() => { executions++; return Job.defer({ executor: "remote", id: "cleanup" }) }), {
      cancel: input => Effect.gen(function* () {
        cleanups++
        if (input !== original) return yield* Effect.die("Cleanup input changed after death")
        yield* Deferred.succeed(cleanupEntered, undefined)
        yield* Deferred.await(releaseCleanup)
      }),
    }), Dying.layer(() => Effect.gen(function* () {
      executions++
      yield* Deferred.await(die)
      return yield* Effect.die("producer exploded")
    }))),
  }))
  let store = await open(1)
  try {
    const records = await waitFor(async () => journal.read(), records => records.some(record => record.event.type === "EffectSettled"))
    const submitted = records.find(record => record.event.type === "EffectSettled")!.event
    if (submitted.type !== "EffectSettled") throw new Error("Missing submission")
    await Effect.runPromise(store.cancel(submitted.ref, "stop"))
    await Effect.runPromise(Deferred.await(cleanupEntered).pipe(Effect.timeout(1_000)))
    await Effect.runPromise(Deferred.succeed(die, undefined))
    await waitFor(async () => journal.read(), records => records.some(record => record.event.type === "EffectDied"))
    const retained = journal.readInputs()
    if (retained.length !== 2 || !retained.some(input => effectKey(input.ref) === effectKey(submitted.ref))) throw new Error("Death released cleanup or forwarding input")
    if (failCleanupCommit) await fixture.execute(name, "CREATE TRIGGER fail_stopped_cleanup BEFORE DELETE ON effect_inputs BEGIN SELECT RAISE(ABORT, 'Injected stopped cleanup failure'); END")
    await Effect.runPromise(Deferred.succeed(releaseCleanup, undefined))
    if (failCleanupCommit) {
      const waitFailure = await Effect.runPromise(Effect.flip(store.wait))
      const recoverFailure = await Effect.runPromise(Effect.flip(store.recover))
      let stateFailure: unknown
      try { store.recoveryState() } catch (error) { stateFailure = error }
      if (!(waitFailure instanceof ActorCommitError) || waitFailure !== recoverFailure || waitFailure !== stateFailure) throw new Error(`Storage failure after death disagreed across APIs: wait=${waitFailure}, recover=${recoverFailure}, state=${stateFailure}`)
      if (journal.readInputs().length !== 2 || journal.read().some(record => record.event.type === "CancellationSettled")) throw new Error("Failed cleanup after death released input or committed acknowledgement")
      await fixture.execute(name, "DROP TRIGGER fail_stopped_cleanup")
      await Effect.runPromise(store.close)
      await Effect.runPromise(journal.close)
      journal = fixture.open(name)
      store = await open(2)
    }
    await waitFor(async () => journal.read(), records => records.some(record => record.event.type === "CancellationSettled"))
    if (journal.readInputs().length !== 0) throw new Error("Cleanup after death retained its payload")
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = fixture.open(name)
    store = await open(2)
    const outcome = await Effect.runPromise(Effect.exit(store.wait))
    if (Exit.isSuccess(outcome) || executions !== 2 || cleanups !== (failCleanupCommit ? 2 : 1)) throw new Error("Death recovery reran execution or acknowledged cleanup")
  } finally {
    await Effect.runPromise(Deferred.succeed(die, undefined))
    await Effect.runPromise(Deferred.succeed(releaseCleanup, undefined))
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
  }
}

export type CancellationStall = "producer" | "cleanup" | "failure" | "defect" | "rejected"

// cancellationStall reproduces unresolved cleanup while retaining durable input; checkpoint-storage.test.ts runs each failure mode.
export async function cancellationStall(fixture: Pick<CleanupFixture, "open">, mode: CancellationStall) {
  const name = `cancellation-stall-${mode}`
  let journal = fixture.open(name)
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const cleanupEntered = Deferred.makeUnsafe<void>()
  let cleanups = 0
  const open = (recover: boolean) => Effect.runPromise(createActorStore({
    actor: actor(recover ? "changed" : original), journal, checkpoint: { mode: "manual" }, effectInput: { digestMinBytes: 0 },
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: Undefined declines the retry decision.
    cancellation: { retryIntervalMs: 1, ...(mode === "rejected" ? { decide: () => Effect.succeed(undefined) } : {}) }, actorContext: Context.pick(),
    services: () => Layer.merge(Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }), Job.layer(() => Effect.gen(function* () {
      if (recover) return yield* Effect.die("Cancelled producer restarted")
      const execution = yield* EffectExecution
      return Job.defer(yield* execution.submit(Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        if (mode === "producer") yield* Deferred.await(release)
        return { executor: "remote", id: "stalled" }
      })))
    }).pipe(Effect.mapError(String)), { cancel: input => Effect.gen(function* () {
      cleanups++
      if (input !== original) return yield* Effect.die("Cleanup lost original input")
      yield* Deferred.succeed(cleanupEntered, undefined)
      if (recover) return
      if (mode === "cleanup") yield* Deferred.await(release)
      if (mode === "failure" || mode === "rejected") return yield* Effect.fail(new RuntimeError("Cleanup unavailable"))
      if (mode === "defect") return yield* Effect.die("Cleanup exploded")
    }) })),
  }))
  let store = await open(false)
  try {
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout(1_000)))
    if (mode !== "producer") await waitFor(async () => journal.read(), records => records.some(record => record.event.type === "EffectSettled"))
    const input = journal.readInputs()[0]!
    await Effect.runPromise(store.cancel(input.ref, "stop"))
    if (journal.lookupInvocation({ atom: input.ref.atom, act: input.ref.act }).status !== "pending") throw new Error("Unfinished cancellation was reported as settled")
    if (mode !== "producer") await Effect.runPromise(Deferred.await(cleanupEntered).pipe(Effect.timeout(1_000)))
    if (mode === "failure") await waitFor(async () => cleanups, count => count >= 3)
    if (mode === "defect" || mode === "rejected") {
      const diagnostic = mode === "defect" ? "Cleanup exploded" : "Cleanup unavailable"
      const outcome = await Effect.runPromise(Effect.exit(store.wait.pipe(Effect.timeout(1_000))))
      if (Exit.isSuccess(outcome) || !Cause.pretty(outcome.cause).includes(diagnostic)) throw new Error(`Cleanup defect was not surfaced: ${Exit.isSuccess(outcome) ? "success" : Cause.pretty(outcome.cause)}`)
      await Effect.runPromise(store.cancel(input.ref, "retry"))
      await Effect.runPromise(Effect.exit(store.wait))
      if (Number(cleanups) !== 1) throw new Error("Duplicate cancellation retried a dead cleanup")
      const records = journal.read()
      const final = records.find(record => mode === "defect" ? record.event.type === "CancellationDied" : record.event.type === "CancellationSettled")?.event
      if (!final || (final.type === "CancellationSettled" && final.outcome.status !== "rejected")
        || records.some(record => record.event.type === "RetryScheduled" || record.event.type === "EffectDied")
        || journal.readInputs().length !== 1) throw new Error("Final cleanup failure lost its durable outcome or input")
      if (Exit.isSuccess(await Effect.runPromise(Effect.exit(store.checkpoint)))) throw new Error("Failed cleanup allowed checkpoint capture")
      await Effect.runPromise(store.close)
      await Effect.runPromise(journal.close)
      journal = fixture.open(name)
      store = await open(true)
      const recovered = await Effect.runPromise(Effect.exit(store.wait.pipe(Effect.timeout(1_000))))
      if (Exit.isSuccess(recovered) || !Cause.pretty(recovered.cause).includes(diagnostic) || Number(cleanups) !== 1
        || !isDeepStrictEqual(journal.read(), records) || journal.readInputs().length !== 1) throw new Error("Recovery repeated or lost final cleanup failure")
      return
    } else {
      const outcome = await Effect.runPromise(store.wait.pipe(Effect.timeoutOption(25)))
      if (outcome._tag !== "None") throw new Error("Unresolved cancellation unexpectedly finished waiting")
      if (mode === "producer" && Number(cleanups) !== 0) throw new Error("Cleanup ran before producer quiescence")
    }
    const records = journal.read()
    if (!records.some(record => record.event.type === "EffectCancelled")
      || records.some(record => record.event.type === "CancellationSettled" || record.event.type === "EffectDied")
      || journal.readInputs().length !== 1) throw new Error("Unresolved cancellation lost input or recorded a terminal outcome")
    if (mode === "producer") {
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await Effect.runPromise(store.wait.pipe(Effect.timeout(1_000)))
    } else {
      await Effect.runPromise(store.close)
      await Effect.runPromise(journal.close)
      journal = fixture.open(name)
      store = await open(true)
      await Effect.runPromise(store.wait.pipe(Effect.timeout(1_000)))
    }
    if (journal.readInputs().length !== 0
      || journal.read().filter(record => record.event.type === "CancellationSettled").length !== 1) throw new Error("Resolved cancellation did not acknowledge and release input")
    if (journal.lookupInvocation({ atom: input.ref.atom, act: input.ref.act }).status !== "settled") throw new Error("Acknowledged cleanup remained pending")
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
  }
}


// cancellationRetryRecovery checks retry counters and wake recovery from journal records on Bun and workerd SQLite.
export async function cancellationRetryRecovery(fixture: Pick<CleanupFixture, "open">) {
  const name = "cancellation-retry-recovery"
  let journal = fixture.open(name)
  const scope = await Effect.runPromise(Scope.make())
  const clock = await Effect.runPromise(TestClock.make().pipe(Effect.provideService(Scope.Scope, scope)))
  const run = <Value, Failure>(effect: Effect.Effect<Value, Failure>) => Effect.runPromise(effect.pipe(Effect.provideService(Clock.Clock, clock)))
  await run(clock.setTime(1_000))
  let executions = 0
  let cleanups = 0
  const decisions: number[] = []
  const open = (version: number) => run(createActorStore({
    actor: actor(version === 1 ? original : "changed"), journal, checkpoint: { mode: "manual" }, effectInput: { digestMinBytes: 0 }, actorContext: Context.pick(),
    cancellation: { decide: (error, attempt) => Effect.sync(() => { decisions.push(attempt); return { delayMs: attempt === 0 ? 1_000 : 0, reason: error.message } }) },
    services: () => Layer.mergeAll(
      Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }),
      Layer.succeed(Scheduler, { schedule: () => Effect.void, cancel: () => Effect.void, restore: Effect.void }),
      Job.layer(() => Effect.gen(function* () {
        const execution = yield* EffectExecution
        return yield* execution.retry(Effect.suspend(() => ++executions === 1 ? Effect.fail("Execution retry") : Effect.succeed(Job.defer({ executor: "remote", id: "retry" }))), {
          decide: failure => Effect.succeed({ delayMs: 0, reason: String(failure) }),
        })
      }).pipe(Effect.mapError(String)), { cancel: input => Effect.gen(function* () {
        if (input !== original) return yield* Effect.die("Cleanup retry lost accepted input")
        if (++cleanups < 3) return yield* Effect.fail(new RuntimeError("Cleanup retry"))
      }) }),
    ),
  }))
  let store = await open(1)
  try {
    const records = await waitFor(async () => journal.read(), records => records.some(record => record.event.type === "EffectSettled"))
    const accepted = records.find(record => record.event.type === "EffectRequested")!.event
    if (accepted.type !== "EffectRequested") throw new Error("Missing accepted request")
    await run(store.cancel(accepted.ref, "stop"))
    await waitFor(async () => store.recoveryState(), state => state.status === "parked")
    if (store.snapshot().retry(accepted.ref)?.attempt !== 1 || store.snapshot().retry(accepted.ref, "cancellation")?.attempt !== 1) throw new Error("Execution and cleanup retry counters interfered")
    if (store.snapshot().checkpoint() !== undefined || Exit.isSuccess(await run(Effect.exit(store.checkpoint)))) throw new Error("Cleanup retry allowed checkpoint capture")
    if ((journal.readCheckpoint()) !== undefined) throw new Error("Cleanup retry persisted a checkpoint")
    await run(store.close)
    await run(journal.close)
    journal = fixture.open(name)
    store = await open(2)
    await waitFor(async () => store.recoveryState(), state => state.status === "parked")
    if (Number(cleanups) !== 1 || store.recoveryState().wakeAt !== 2_000) throw new Error("Recovery lost the cleanup retry deadline")
    await run(clock.setTime(2_000))
    await run(store.resume)
    await run(store.wait)
    await run(store.checkpoint)
    const checkpoint = journal.readCheckpoint()
    if (!checkpoint || JSON.parse(new TextDecoder().decode(checkpoint.payload)).version !== 4) throw new Error("Cleanup checkpoint lost its current encoding")
    const history = journal.read()
    const retries = history.flatMap(record => record.event.type === "RetryScheduled" && record.event.phase === "cancellation" ? [record.event.attempt] : [])
    if (!isDeepStrictEqual(retries, [1, 2]) || !isDeepStrictEqual(decisions, [0, 1]) || Number(cleanups) !== 3 || executions !== 2
      || history.filter(record => record.event.type === "CancellationSettled").length !== 1 || journal.readInputs().length !== 0) throw new Error("Cleanup retry did not preserve its sequence or discharge input")
  } finally { await run(store.close); await run(journal.close); await run(Scope.close(scope, Exit.succeed(undefined))) }
}
