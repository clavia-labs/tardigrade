import { strict as assert } from "node:assert"
import * as fc from "fast-check"
import { Clock, Context, Effect } from "effect"
import { TestClock } from "effect/testing"
import { createWatchdog, RuntimeError, watchdogKey, type Journal, type Recorded } from "@clavia/tardigrade-core"
import { slowActor, slowServices } from "../../fixtures/slow-act"
import { memoryWatchdog } from "../../fixtures/watchdog"
import { createTestStore } from "../runtime/store"

const policy = { attemptTimeoutMs: 100, keepAliveIntervalMs: 20, retryIntervalMs: 20, maxRetryIntervalMs: 40, maxNoProgressAttempts: 3 }
const cases = fc.record({ workMs: fc.integer({ min: 200, max: 600 }), value: fc.integer(), restart: fc.boolean(), forked: fc.boolean() })

// slowExecutionRecovery checks slow execution and cold recovery under virtual time (bun/watchdog.test.ts).
export const slowExecutionRecovery = fc.asyncProperty(cases, options => Effect.runPromise(Effect.gen(function* () {
  const clock = yield* TestClock.make()
  const fixture = slowServices({ workMs: options.workMs, value: options.value, ...(options.forked ? { fork: { timeoutMs: options.workMs + 5_000 } } : {}) })
  type Input = { readonly type: "RunRequested" }
  const records: Recorded<Input>[] = []
  const journal: Journal<Input> = {
    read: Effect.sync(() => [...records]), readAfter: position => Effect.sync(() => records.slice(position)),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: Journal requires an undefined checkpoint.
    readCheckpoint: Effect.succeed(undefined),
    append: (position, events) => Effect.sync(() => { assert.equal(position, records.length); records.push(...events) }),
    appendWithCheckpoint: () => Effect.fail(new RuntimeError("Unexpected checkpoint")),
  }
  const open = () => createTestStore({ actor: slowActor, journal, checkpoint: { mode: "manual" }, actorContext: () => Context.empty(), services: () => fixture.services })
  yield* Effect.gen(function* () {
    let store = yield* open()
    let live = true
    let invalidations = 0
    const db = memoryWatchdog()
    const target = { actor: "slow", instance: "main", thread: "one" }
    const key = watchdogKey(target)
    const reopen = () => createWatchdog({ storage: db.storage, policy,
      probe: () => Effect.sync(() => live ? store.recoveryState() : undefined),
      recover: () => Effect.gen(function* () {
        if (!live) { store = yield* open(); live = true }
        yield* store.recover
        return store.recoveryState()
      }),
      invalidate: () => Effect.sync(() => { invalidations++ }),
    })
    let watchdog = reopen()
    yield* Effect.gen(function* () {
      yield* store.send([{ type: "RunRequested" }])
      yield* fixture.started(1)
      yield* clock.adjust(0)
      yield* db.storage.transaction(tx => watchdog.admit(tx, target))
      yield* watchdog.alarm
      assert.equal(db.records().get(key)?.attempts, 0)
      if (options.restart) {
        yield* store.close
        live = false
        watchdog = reopen()
        yield* clock.setTime(db.alarm()!)
        yield* watchdog.alarm
        yield* fixture.started(2)
        yield* clock.adjust(0)
      }
      const start = fixture.log().filter(entry => entry.kind === "start").at(-1)!.at
      while ((yield* Clock.currentTimeMillis) < start + options.workMs) {
        yield* clock.adjust(Math.min(policy.keepAliveIntervalMs, start + options.workMs - (yield* Clock.currentTimeMillis)))
        yield* watchdog.alarm
        const entry = db.records().get(key)
        if (entry) {
          assert.equal(entry.status, "pending")
          assert.equal(entry.attempts, options.restart ? 1 : 0)
          assert.ok(entry.consecutiveNoProgress <= Number(options.restart))
        }
      }
      yield* store.wait
      if (db.alarm() !== null) yield* clock.setTime(db.alarm()!)
      yield* watchdog.alarm
      assert.deepEqual(store.getState().view, { status: "fulfilled", value: options.value })
      const log = fixture.log()
      assert.equal(log.filter(entry => entry.kind === "start").length, options.restart ? 2 : 1)
      assert.equal(log.filter(entry => entry.kind === "done").length, 1)
      assert.equal(log.filter(entry => entry.kind === "interrupted").length, options.restart ? 1 : 0)
      assert.equal(log.find(entry => entry.kind === "done")!.at - start, options.workMs)
      assert.equal(invalidations, 0)
      assert.equal(db.records().size, 0)
      assert.equal(db.alarm(), null)
    }).pipe(Effect.ensuring(Effect.suspend(() => store.close)))
  }).pipe(Effect.provideService(Clock.Clock, clock))
}).pipe(Effect.scoped)))
