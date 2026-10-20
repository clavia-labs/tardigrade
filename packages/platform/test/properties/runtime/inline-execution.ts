import { strict as assert } from "node:assert"
import { Clock, Context, Deferred, Effect, Schema } from "effect"
import * as fc from "fast-check"
import { act, createWatchdog, defineActor, durableAtom, effectAtom, EffectExecution, RetryScheduled, watchdogKey } from "@clavia/tardigrade-core"
import { memoryWatchdog } from "../../fixtures/watchdog"
import { waitFor } from "../../fixtures/wait"
import { createTestStore } from "./store"

const cases = fc.record({
  value: fc.integer(), rejected: fc.boolean(), retryWait: fc.boolean(),
  maxAttempts: fc.integer({ min: 1, max: 3 }), extraHeartbeats: fc.integer({ min: 1, max: 8 }),
  keepAliveIntervalMs: fc.integer({ min: 1, max: 100 }), retryDelayMs: fc.integer({ min: 10_000, max: 60_000 }),
})

export const inlineExecutionSupervision = fc.asyncProperty(cases, options => Effect.runPromise(Effect.gen(function* () {
  const Start = Schema.Struct({ type: Schema.Literal("Start") })
  const Job = act({ name: "test.inline-supervision", input: Schema.Null, success: Schema.Finite, failure: Schema.String })
  const actor = defineActor("inline-supervision", Effect.sync(() => {
    const started = durableAtom({ name: "inline.started", input: Start, schema: Schema.Boolean, initial: false, reduce: () => true })
    const job = Job.request({ input: null })
    return { schema: Start, atom: effectAtom(get => ({ view: get(job.result), events: {}, acts: get(started) && get(job.result).status === "pending" ? { job } : {} })) }
  }))
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let starts = 0
  let interruptions = 0
  const store = yield* createTestStore({ actor, actorContext: () => Context.empty(), services: () => Job.layer(() => Effect.gen(function* () {
    starts++
    const execution = yield* EffectExecution
    yield* Deferred.succeed(entered, undefined)
    yield* Deferred.await(release)
    if (options.retryWait) return yield* execution.retry(Effect.fail("retry"), { decide: () => Effect.succeed({ delayMs: options.retryDelayMs, reason: "retry" }) })
    if (options.rejected) return yield* Effect.fail("failed")
    return options.value
  }).pipe(Effect.mapError(String), Effect.onInterrupt(() => Effect.sync(() => { interruptions++ })))) })
  yield* Effect.gen(function* () {
    const target = { actor: "inline-supervision", instance: "main", thread: "one" }
    const key = watchdogKey(target)
    const db = memoryWatchdog(), storage = db.storage
    let recoveries = 0
    let invalidations = 0
    const watchdog = createWatchdog({ storage, policy: { maxAttempts: options.maxAttempts, maxNoProgressAttempts: options.maxAttempts, keepAliveIntervalMs: options.keepAliveIntervalMs },
      probe: () => Effect.sync(() => store.recoveryState()),
      recover: () => Effect.sync(() => { recoveries++; return store.recoveryState() }),
      invalidate: () => Effect.sync(() => { invalidations++ }),
    })
    const wake = storage.transaction(tx => tx.get(key).pipe(Effect.flatMap(entry => entry ? tx.put(key, { ...entry, nextWakeAt: 0 }) : Effect.void))).pipe(Effect.andThen(watchdog.alarm))
    yield* store.send([{ type: "Start" }])
    yield* Deferred.await(entered)
    yield* storage.transaction(tx => watchdog.admit(tx, target))
    for (let index = 0; index < options.maxAttempts + options.extraHeartbeats; index++) {
      assert.equal(store.recoveryState().status, "running")
      assert.equal(store.recoveryState().wakeAt, undefined)
      const before = yield* Clock.currentTimeMillis
      yield* wake
      const after = yield* Clock.currentTimeMillis
      const alarm = db.alarm()
      assert.ok(alarm !== null && alarm >= before + options.keepAliveIntervalMs && alarm <= after + options.keepAliveIntervalMs)
      assert.equal(db.records().get(key)?.attempts, 0)
      assert.equal(db.records().get(key)?.consecutiveNoProgress, 0)
      assert.equal(db.records().get(key)?.status, "pending")
    }
    assert.equal(starts, 1)
    assert.equal(interruptions, 0)
    assert.equal(recoveries, 0)
    assert.equal(invalidations, 0)
    yield* Deferred.succeed(release, undefined)
    if (options.retryWait) {
      yield* Effect.promise(() => waitFor(() => Promise.resolve(store.recoveryState()), state => state.status === "parked"))
      const retry = store.snapshot().events.find(Schema.is(RetryScheduled))
      assert.ok(retry)
      assert.equal(store.recoveryState().wakeAt, retry.dueAt)
      yield* wake
      assert.equal(db.alarm(), retry.dueAt)
      yield* store.cancel(retry.ref, "stop")
    }
    yield* store.wait
    assert.equal(store.recoveryState().status, "settled")
    assert.deepEqual(store.getState().view, options.retryWait ? { status: "rejected", reason: { _tag: "Cancelled", reason: "stop" } }
      : options.rejected ? { status: "rejected", reason: "failed" } : { status: "fulfilled", value: options.value })
    yield* wake
    assert.equal(db.records().size, 0)
    assert.equal(db.alarm(), null)
    assert.equal(starts, 1)
    assert.equal(recoveries, 0)
    assert.equal(invalidations, 0)
  }).pipe(Effect.ensuring(store.close))
}).pipe(Effect.scoped, Effect.timeout(2_000))))
