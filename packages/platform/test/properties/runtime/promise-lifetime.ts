import { strict as assert } from "node:assert"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as fc from "fast-check"
import { DEFAULT_PROMISE_POLICY, ExecutionResult, RuntimeError, Scheduler, type Recorded, type Journal, type WakeRequest } from "@clavia/tardigrade-core"
import { slowActor, slowServices, type SlowEvent } from "../../fixtures/slow-act"
import { memoryJournalReads } from "../../fixtures/memory-journal"
import { createTestStore } from "./store"

// promiseLifetimeRecovery checks recorded timeout choices survive changed configuration and local producer recreation.
export const promiseLifetimeRecovery = fc.asyncProperty(fc.boolean(), fc.boolean(), fc.integer(), (unbounded, oldEnvelope, value) => Effect.runPromise(Effect.gen(function* () {
  const clock = yield* TestClock.make()
  yield* Effect.gen(function* () {
    const records: Recorded<SlowEvent>[] = []
    const wakes: WakeRequest[] = []
    const journal: Journal<SlowEvent> = { ...memoryJournalReads(() => records), readCheckpoint: () => undefined,
      append: (position, batch) => { assert.equal(position, records.length); records.push(...batch) },
      appendWithCheckpoint: () => { throw new RuntimeError("Unexpected checkpoint") },
    }
    const open = (timeoutMs: number | null) => Effect.gen(function* () {
      const fixture = slowServices({ workMs: 0, value, hold: true, fork: { timeoutMs } })
      const store = yield* createTestStore({ actor: slowActor, journal, attemptTimeoutMs: null, actorContext: Context.pick(),
        services: () => Layer.merge(fixture.services, Layer.succeed(Scheduler, {
          schedule: wake => Effect.sync(() => { wakes.push(wake) }), cancel: () => Effect.void, restore: Effect.void,
        })),
      })
      return { store, fixture }
    })
    const first = yield* open(unbounded ? null : 200_000)
    let deadlineAt: number | undefined
    yield* Effect.gen(function* () {
      yield* first.store.send([{ type: "RunRequested" }])
      yield* first.fixture.started(1)
      while (!first.store.snapshot().deferred().length) yield* Effect.yieldNow
      yield* first.store.recover
      const pending = first.store.snapshot().deferred()[0]!
      assert.equal(pending.unbounded, unbounded ? true : undefined)
      deadlineAt = pending.deadlineAt
      assert.equal(deadlineAt === undefined, unbounded)
    }).pipe(Effect.ensuring(first.store.close))
    const legacy = oldEnvelope && !unbounded
    if (legacy) {
      for (const [index, record] of records.entries()) {
        const event = record.event
        if (event.type !== "EffectSettled" || event.outcome.status !== "fulfilled") continue
        const result = yield* Schema.decodeUnknownEffect(ExecutionResult)(event.outcome.value).pipe(Effect.mapError(RuntimeError.from))
        if (result.type === "promise") records[index] = { ...record, event: { ...event, outcome: { status: "fulfilled", value: { type: "promise", handle: result.handle } } } }
      }
      deadlineAt = undefined
    }
    const reopened = yield* open(unbounded ? 10 : null)
    yield* Effect.gen(function* () {
      yield* reopened.fixture.started(1)
      yield* reopened.store.recover
      const pending = reopened.store.snapshot().deferred()[0]!
      assert.equal(pending.unbounded, unbounded ? true : undefined)
      assert.equal(pending.deadlineAt, deadlineAt)
      assert.equal(wakes.length, unbounded ? 0 : 2)
      if (!unbounded) assert.equal(wakes[1]!.dueAt, legacy ? DEFAULT_PROMISE_POLICY.timeoutMs : deadlineAt)
      yield* clock.adjust(legacy ? 1 : 120_000)
      assert.deepEqual(reopened.store.recoveryState(), { progressCursor: reopened.store.snapshot().progressCursor, status: legacy ? "pending" : "running", ...(deadlineAt === undefined ? {} : { wakeAt: deadlineAt }) })
      yield* reopened.fixture.release
      yield* reopened.store.wait
      assert.deepEqual(reopened.store.getState().view, { status: "fulfilled", value })
      for (const type of ["EffectRequested", "EffectSettled", "PromiseSettled"]) assert.equal(records.filter(record => record.event.type === type).length, 1)
    }).pipe(Effect.ensuring(reopened.store.close))
  }).pipe(Effect.provideService(Clock.Clock, clock))
}).pipe(Effect.scoped, Effect.timeout(5_000))))
