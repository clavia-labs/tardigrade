import { Clock, Cause, Deferred, Effect, Exit } from "effect"
import { RuntimeError } from "@clavia/tardigrade-core"
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
      assert(count("experimental_events") === 1 && count("stored_scheduler_wakes") === 1, "Alarm failure lost or duplicated committed creation and recovery")
    }
    const persisted = () => driver.execute("SELECT entry FROM stored_scheduler_wakes", []).map(row => String(row.entry))
    const committed = persisted()
    for (let repeat = 0; repeat <= options.repeats; repeat++) {
      await run(initializeThread(journal, creation))
      const earliest = Math.min(...persisted().map(entry => (JSON.parse(entry) as { nextWakeAt: number }).nextWakeAt))
      assert(armed === earliest, "Provisioning succeeded without arming the earliest committed wake")
      assert(count("experimental_events") === 1 && JSON.stringify(persisted()) === JSON.stringify(committed), "Provisioning retry changed committed creation or recovery identity")
    }
    assert(order.length === 2 * (options.failures + options.repeats + 1) && order.every((step, index) => step === (index % 2 ? "set" : "flush")), "Acknowledgement did not flush before synchronizing the alarm")
    await run(journal.scheduler!.alarm)
    assert(recoveries === 1 && armed === null && count("stored_scheduler_wakes") === 0, "Acknowledged recovery did not run and clear its wake")
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
