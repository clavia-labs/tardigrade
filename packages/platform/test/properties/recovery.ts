import assert from "node:assert/strict"
import { TestClock } from "effect/testing"
import { slowActor, slowServices } from "../fixtures/slow-act"
import { createTestStore } from "./runtime/store"
import { Clock, Cause, Context, Deferred, Effect, Exit, Layer, Schema } from "effect"
import { RuntimeError, ExecutionResult, PromiseSettled, Scheduler, effectKey, watchdogKey, type RecoveryState } from "@clavia/tardigrade-core"
import { initializeThread } from "@clavia/tardigrade-core/services/journal/thread"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { synchronousJournal } from "../../src/shared/synchronous-journal"

export interface AcknowledgementCase {
  readonly failures: number
  readonly repeats: number
  readonly now: number
}

// acknowledgementRetry preserves one creation and arms its committed recovery wake before a provisioning retry succeeds (bun/journal.test.ts; workerd/journal.workers.ts).
export async function acknowledgementRetry(driver: SyncSqlite, options: AcknowledgementCase) {
  const base = Effect.runSync(Clock.clockWith(Effect.succeed))
  const clock: Clock.Clock = { ...base, currentTimeMillisUnsafe: () => options.now, currentTimeMillis: Effect.succeed(options.now) }
  const run = <Value, Failure>(work: Effect.Effect<Value, Failure>) => Effect.runPromise(work.pipe(Effect.provideService(Clock.Clock, clock)))
  const target = { actor: "acknowledgement", instance: "one", thread: "main" }
  const creation = { type: "ThreadCreated" as const, address: target, parent: null, depth: 0, placement: "independent" as const }
  const order: string[] = []
  let failures = options.failures, armed: number | null = null, recoveries = 0
  const journal: ReturnType<typeof synchronousJournal> = synchronousJournal({ actor: "acknowledgement", driver,
    flush: Effect.sync(() => { order.push("flush") }),
    scheduler: { deliver: () => journal.watchdog!.alarm, alarm: {
      set: at => Effect.gen(function* () {
        order.push("set")
        if (failures-- > 0) return yield* Effect.fail(new RuntimeError("Injected physical alarm failure"))
        armed = at
      }),
      clear: Effect.sync(() => { armed = null }),
    } },
    watchdog: { target, recover: () => Effect.sync(() => { recoveries++; return { status: "settled" as const, progressCursor: 1 } }), invalidate: () => Effect.void },
  })
  const count = (table: string) => Number(driver.execute(`SELECT COUNT(*) n FROM ${table}`, [])[0]!.n)
  const assert = (condition: boolean, message: string) => { if (!condition) throw new RuntimeError(message) }
  try {
    for (let failure = 0; failure < options.failures; failure++) {
      const result = await run(Effect.exit(initializeThread(journal, creation)))
      assert(Exit.isFailure(result) && Cause.pretty(result.cause).includes("Injected physical alarm failure"), "Provisioning acknowledged a failed alarm update")
      assert(armed === null, "Failed alarm update unexpectedly armed recovery")
      assert(count("experimental_events") === 1 && count("scheduled_wakes") === 1, "Alarm failure lost or duplicated committed creation and recovery")
    }
    const persisted = () => driver.execute("SELECT entry FROM scheduled_wakes", []).map(row => String(row.entry))
    const committed = persisted()
    for (let repeat = 0; repeat <= options.repeats; repeat++) {
      await run(initializeThread(journal, creation))
      const earliest = Math.min(...persisted().map(entry => (JSON.parse(entry) as { nextWakeAt: number }).nextWakeAt))
      assert(armed === earliest, "Provisioning succeeded without arming the earliest committed wake")
      assert(count("experimental_events") === 1 && JSON.stringify(persisted()) === JSON.stringify(committed), "Provisioning retry changed committed creation or recovery identity")
    }
    assert(order.length === 2 * (options.failures + options.repeats + 1) && order.every((step, index) => step === (index % 2 ? "set" : "flush")), "Acknowledgement did not flush before synchronizing the alarm")
    await run(journal.scheduler!.alarm)
    assert(recoveries === 1 && armed === null && count("scheduled_wakes") === 0, "Acknowledged recovery did not run and clear its wake")
  } finally { await run(journal.close) }
}

// acknowledgementOrdering preserves the earliest wake when a competing schedule arrives during acknowledgement alarm I/O (bun/journal.test.ts; workerd/journal.workers.ts).
export async function acknowledgementOrdering(driver: SyncSqlite, early: number, gap: number) {
  const entered = Deferred.makeUnsafe<void>(), release = Deferred.makeUnsafe<void>()
  let block = false, armed: number | null = null
  const journal = synchronousJournal({ actor: "acknowledgement-order", driver, scheduler: { deliver: () => Effect.void, alarm: {
    set: at => Effect.gen(function* () {
      if (block) { block = false; yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release) }
      armed = at
    }), clear: Effect.sync(() => { armed = null }),
  } } })
  const run = <Value, Failure>(work: Effect.Effect<Value, Failure>) => Effect.runPromise(work)
  let pending: Promise<void> | undefined, competing: Promise<void> | undefined
  try {
    await run(journal.scheduler!.schedule({ id: "late", target: null, dueAt: early + gap }))
    block = true
    pending = run(journal.acknowledge)
    await run(Deferred.await(entered))
    competing = run(journal.scheduler!.schedule({ id: "early", target: null, dueAt: early }))
    await run(Effect.yieldNow)
    await run(Deferred.succeed(release, undefined))
    await Promise.all([pending, competing])
    if (armed !== early) throw new RuntimeError("Acknowledgement overwrote an earlier committed recovery wake")
  } finally {
    await run(Deferred.succeed(release, undefined))
    await Promise.allSettled([pending, competing])
    await run(journal.close)
  }
}

// promiseDeadlineRecovery checks durable expiry after blocked recovery and reopening (bun/journal.test.ts; workerd/journal.workers.ts).
export async function promiseDeadlineRecovery(driver: SyncSqlite, { budget, slackMs, legacy }: { readonly budget: number; readonly slackMs: number; readonly legacy: boolean }) {
  await Effect.runPromise(Effect.gen(function* () {
    const clock = yield* TestClock.make()
    yield* Effect.gen(function* () {
      const timeoutMs = budget + slackMs
      const fixture = slowServices({ workMs: timeoutMs, value: 42, hold: true, fork: { timeoutMs } })
      const target = { actor: "deadline", instance: "main", thread: "one" }
      const closes: Array<Effect.Effect<void>> = []
      let probe: (() => RecoveryState) | undefined
      let alarmAt: number | null = null
      let attempts = 0
      let journal!: ReturnType<typeof synchronousJournal<{ type: "RunRequested" }>>
      const runtime = () => createTestStore({ actor: slowActor, journal, checkpoint: { mode: "manual" },
        canDrive: journal.watchdog!.blocked(target).pipe(Effect.map(blocked => !blocked)),
        actorContext: Context.pick(), services: () => Layer.merge(fixture.services, Layer.succeed(Scheduler, journal.scheduler!)),
      }).pipe(Effect.tap(store => Effect.sync(() => { closes.push(store.close.pipe(Effect.orDie)) })))
      const open = () => synchronousJournal<{ type: "RunRequested" }>({ actor: "deadline", driver,
        scheduler: {
          alarm: { set: at => Effect.sync(() => { alarmAt = at }), clear: Effect.sync(() => { alarmAt = null }) },
          deliver: wake => Effect.gen(function* () {
            if (typeof wake.target === "object" && wake.target !== null && "owner" in wake.target && wake.target.owner === "effect") {
              const restored = yield* runtime()
              probe = restored.recoveryState
              yield* restored.recover
            } else yield* journal.watchdog!.alarm
          }),
        },
        watchdog: { target, policy: { maxAttempts: budget, maxNoProgressAttempts: budget, retryIntervalMs: 1, maxRetryIntervalMs: 1 },
          recover: () => Effect.suspend(() => { attempts++; return Effect.fail(new RuntimeError("Producer isolate reset")) }),
          invalidate: () => Effect.void, probe: () => Effect.sync(() => probe?.()),
        },
      })
      journal = open()
      yield* Effect.gen(function* () {
        const initial = yield* runtime()
        yield* initial.send([{ type: "RunRequested" }])
        yield* fixture.started(1)
        while (!initial.snapshot().deferred().length) yield* Effect.yieldNow
        const settled = initial.snapshot().events.find(event => event.type === "EffectSettled")
        if (!settled || settled.type !== "EffectSettled" || settled.outcome.status !== "fulfilled") return yield* Effect.fail(new RuntimeError("Missing promise envelope"))
        const envelope = yield* Schema.decodeUnknownEffect(ExecutionResult)(settled.outcome.value)
        if (envelope.type !== "promise" || envelope.deadlineAt === undefined) return yield* Effect.fail(new RuntimeError("Missing promise deadline"))
        const deadlineAt = envelope.deadlineAt
        yield* initial.close
        for (let index = 0; index < budget; index++) {
          if (alarmAt === null) return yield* Effect.fail(new RuntimeError("Recovery wake disappeared before budget exhaustion"))
          yield* clock.setTime(alarmAt)
          alarmAt = null
          yield* journal.scheduler!.alarm
        }
        assert.equal(attempts, budget)
        assert.equal((yield* journal.watchdog!.status).get(watchdogKey(target))?.status, "blocked")
        assert((yield* Clock.currentTimeMillis) < deadlineAt)
        const records = yield* journal.read
        if (legacy) {
          yield* journal.scheduler!.cancel(`promise:${effectKey(settled.ref)}`)
          const upgraded = yield* runtime()
          yield* upgraded.recover
          yield* upgraded.close
        }
        yield* journal.close
        journal = open()
        yield* journal.scheduler!.restore
        yield* journal.watchdog!.restore
        assert.deepEqual(yield* journal.read, records)
        assert.equal(records.some(record => record.event.type === "PromiseSettled"), false)
        assert.notEqual(alarmAt, null, "Unsettled promise lost its deadline wake when recovery blocked")
        assert(alarmAt! <= deadlineAt)
        yield* clock.setTime(deadlineAt)
        yield* journal.scheduler!.alarm
        yield* journal.scheduler!.alarm
        const final = yield* journal.read
        const timeouts = final.map(record => record.event).filter(Schema.is(PromiseSettled))
        assert.equal(timeouts.length, 1)
        assert.deepEqual(timeouts[0]!.result, { status: "rejected", reason: { _tag: "PromiseTimedOut", deadlineAt } })
        assert.equal(fixture.log().filter(entry => entry.kind === "start").length, 1)
        assert.equal((yield* journal.watchdog!.status).size, 0)
        assert.equal(alarmAt, null)
        yield* Effect.forEach(closes, close => close)
        probe = undefined
        const completed = yield* runtime()
        yield* completed.recover
        assert.equal((yield* journal.read).filter(record => Schema.is(PromiseSettled)(record.event)).length, 1)
        assert.equal(fixture.log().filter(entry => entry.kind === "start").length, 1)
      }).pipe(Effect.ensuring(Effect.suspend(() => Effect.forEach(closes, close => close).pipe(Effect.andThen(journal.close), Effect.orDie))))
    }).pipe(Effect.provideService(Clock.Clock, clock))
  }).pipe(Effect.scoped))
}
