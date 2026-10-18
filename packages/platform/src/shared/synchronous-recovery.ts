import { Effect, Schema, Semaphore } from "effect"
import { RuntimeError, ScheduledWake, WatchdogEntry, schedulerOwner, type Alarm, type SchedulerTransaction, type WatchdogTransaction } from "@clavia/tardigrade-core"
import type { Transaction } from "@tardie/grove/sqlite"
import type { makeSync } from "@tardie/grove/sqlite"

const locks = new WeakMap<object, ReturnType<typeof Semaphore.makeUnsafe>>()
export const recoveryLock = (identity: object) => {
  let lock = locks.get(identity)
  if (!lock) { lock = Semaphore.makeUnsafe(1); locks.set(identity, lock) }
  return lock
}

// synchronousRecoveryStorage serializes native recovery commits and physical alarm updates (test/bun/journal.test.ts).
export function synchronousRecoveryStorage(grove: ReturnType<typeof makeSync>, identity: object, actor: string, alarm: typeof Alarm.Service, flush: Effect.Effect<void, Error>, guard: () => void = () => {}) {
  const attempt = <Value>(work: () => Value) => Effect.try({ try: () => { guard(); return work() }, catch: RuntimeError.from })
  const sync = attempt(() => grove.transaction(tx => Effect.runSync(syncRecoveryTransaction(tx, actor, alarm).scheduler.list))).pipe(Effect.flatMap(entries => {
    let earliest: number | undefined
    for (const entry of entries.values()) earliest = earliest === undefined ? entry.nextWakeAt : Math.min(earliest, entry.nextWakeAt)
    return earliest === undefined ? alarm.clear : alarm.set(earliest)
  }))
  const finish = flush.pipe(Effect.andThen(sync))
  const transaction = <Value>(work: (tx: ReturnType<typeof syncRecoveryTransaction>) => Effect.Effect<Value, Error>) => recoveryLock(identity).withPermit(Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    const result = yield* attempt(() => {
      if (grove.transactionActive()) throw new Error("Recovery must own the native transaction")
      return grove.transaction(tx => Effect.runSyncWith(context)(work(syncRecoveryTransaction(tx, actor, alarm))))
    })
    yield* finish
    return result
  }).pipe(Effect.uninterruptible))
  return { transaction, finish }
}

// initializeSyncRecovery creates actor-scoped wake and recovery tables (test/bun/journal.test.ts).
export function initializeSyncRecovery(tx: Pick<Transaction, "execute">) {
  tx.execute("CREATE TABLE IF NOT EXISTS stored_scheduler_wakes(actor TEXT NOT NULL,id TEXT NOT NULL,entry TEXT NOT NULL,PRIMARY KEY(actor,id)) WITHOUT ROWID", [])
  tx.execute("CREATE TABLE IF NOT EXISTS stored_scheduler_generation(actor TEXT PRIMARY KEY,value INTEGER NOT NULL) WITHOUT ROWID", [])
  tx.execute("CREATE TABLE IF NOT EXISTS stored_watchdog_entries(actor TEXT NOT NULL,id TEXT NOT NULL,entry TEXT NOT NULL,PRIMARY KEY(actor,id)) WITHOUT ROWID", [])
}

// syncRecoveryTransaction expires with its Grove transaction (test/bun/journal.test.ts).
export function syncRecoveryTransaction(tx: Transaction, actor: string, alarm: typeof Alarm.Service): { scheduler: SchedulerTransaction; watchdog: WatchdogTransaction } {
  const io = <Value>(work: () => Value) => Effect.try({ try: work, catch: RuntimeError.from })
  const entries = <Value>(table: string, schema: Schema.Decoder<Value>) => {
    const decode = (entry: unknown) => Schema.decodeUnknownSync(schema)(JSON.parse(String(entry)))
    return {
      get: (id: string) => io(() => { const row = tx.execute(`SELECT entry FROM ${table} WHERE actor=? AND id=?`, [actor, id])[0]; return row ? decode(row.entry) : undefined }),
      put: (id: string, entry: Value) => io(() => { const value = Schema.decodeUnknownSync(schema)(entry); tx.execute(`INSERT INTO ${table}(actor,id,entry) VALUES(?,?,?) ON CONFLICT(actor,id) DO UPDATE SET entry=excluded.entry`, [actor, id, JSON.stringify(value)]) }),
      delete: (id: string) => io(() => { tx.execute(`DELETE FROM ${table} WHERE actor=? AND id=?`, [actor, id]) }),
      list: io(() => new Map(tx.execute(`SELECT id,entry FROM ${table} WHERE actor=? ORDER BY id`, [actor]).map(row => [String(row.id), decode(row.entry)]))),
    }
  }
  const wakes = entries("stored_scheduler_wakes", ScheduledWake)
  const scheduler: SchedulerTransaction = {
    ...wakes, alarm,
    put: entry => wakes.put(entry.id, entry),
    allocateGeneration: io(() => {
      const row = tx.execute("INSERT INTO stored_scheduler_generation(actor,value) VALUES(?,1) ON CONFLICT(actor) DO UPDATE SET value=value+1 WHERE value<? RETURNING value", [actor, Number.MAX_SAFE_INTEGER])[0]
      if (!row) throw new Error("Scheduler generation exhausted")
      return Number(row.value)
    }),
  }
  return { scheduler, watchdog: { ...entries("stored_watchdog_entries", WatchdogEntry), alarm: schedulerOwner(scheduler, "watchdog", { owner: "watchdog" }) } }
}
