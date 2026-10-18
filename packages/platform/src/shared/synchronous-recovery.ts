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

// wakeStates records per database whether scheduled wakes changed since the earliest wake was last read, and that wake.
const wakeStates = new WeakMap<object, { changed: boolean; earliest: number | undefined }>()
const wakeState = (identity: object) => {
  let state = wakeStates.get(identity)
  if (!state) { state = { changed: true, earliest: undefined }; wakeStates.set(identity, state) }
  return state
}
const earliestWake = (tx: Pick<Transaction, "execute">) => {
  let earliest: number | undefined
  for (const row of tx.execute("SELECT entry FROM scheduled_wakes", [])) {
    const at = Schema.decodeUnknownSync(ScheduledWake)(JSON.parse(String(row.entry))).nextWakeAt
    earliest = earliest === undefined ? at : Math.min(earliest, at)
  }
  return earliest
}
// stageWakes reads the earliest wake inside tx when its database's wakes changed; commitWakes records it once tx commits, so the alarm needs no separate scan.
export const stageWakes = (tx: Pick<Transaction, "execute">, identity: object) => wakeState(identity).changed ? { earliest: earliestWake(tx) } : undefined
export const commitWakes = (identity: object, staged: { readonly earliest: number | undefined } | undefined) => {
  if (!staged) return
  const state = wakeState(identity)
  state.changed = false; state.earliest = staged.earliest
}

// synchronousRecoveryStorage serializes native recovery commits and physical alarm updates; it rescans wakes only after a write to them (test/bun/journal.test.ts).
export function synchronousRecoveryStorage(grove: ReturnType<typeof makeSync>, identity: object, alarm: typeof Alarm.Service, flush: Effect.Effect<void, Error>, guard: () => void = () => {}) {
  const attempt = <Value>(work: () => Value) => Effect.try({ try: () => { guard(); return work() }, catch: RuntimeError.from })
  const arm = (earliest: number | undefined) => earliest === undefined ? alarm.clear : alarm.set(earliest)
  const sync = Effect.suspend(() => {
    const state = wakeState(identity)
    if (!state.changed) return arm(state.earliest)
    return attempt(() => grove.transaction(tx => stageWakes(tx, identity))).pipe(Effect.flatMap(staged => {
      commitWakes(identity, staged)
      return arm(state.earliest)
    }))
  })
  const finish = flush.pipe(Effect.andThen(sync))
  const transaction = <Value>(work: (tx: ReturnType<typeof syncRecoveryTransaction>) => Effect.Effect<Value, Error>) => recoveryLock(identity).withPermit(Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    const result = yield* attempt(() => {
      if (grove.transactionActive()) throw new Error("Recovery must own the native transaction")
      let staged: ReturnType<typeof stageWakes>
      const value = grove.transaction(tx => {
        const value = Effect.runSyncWith(context)(work(syncRecoveryTransaction(tx, alarm, identity)))
        staged = stageWakes(tx, identity)
        return value
      })
      commitWakes(identity, staged)
      return value
    })
    yield* finish
    return result
  }).pipe(Effect.uninterruptible))
  // read runs work under the recovery lock without the commit's alarm resync; work must not write.
  const read = <Value>(work: (tx: ReturnType<typeof syncRecoveryTransaction>) => Effect.Effect<Value, Error>) => recoveryLock(identity).withPermit(Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    return yield* attempt(() => {
      if (grove.transactionActive()) throw new Error("Recovery must own the native transaction")
      return grove.transaction(tx => Effect.runSyncWith(context)(work(syncRecoveryTransaction(tx, alarm, identity))))
    })
  }))
  return { transaction, read, finish }
}

// initializeSyncRecovery creates wake and recovery tables for one database (test/bun/journal.test.ts).
export function initializeSyncRecovery(tx: Pick<Transaction, "execute">) {
  tx.execute("CREATE TABLE IF NOT EXISTS scheduled_wakes(id TEXT PRIMARY KEY,entry TEXT NOT NULL) WITHOUT ROWID", [])
  tx.execute("CREATE TABLE IF NOT EXISTS scheduler_generation(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL) WITHOUT ROWID", [])
  tx.execute("CREATE TABLE IF NOT EXISTS watchdogs(id TEXT PRIMARY KEY,entry TEXT NOT NULL) WITHOUT ROWID", [])
  const sources = [["stored_scheduler_wakes", "scheduled_wakes", "id,entry"], ["stored_scheduler_generation", "scheduler_generation", "value"], ["stored_watchdog_entries", "watchdogs", "id,entry"]] as const
  let identity: unknown
  for (const [source, target, columns] of sources) {
    if (!tx.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [source]).length) continue
    for (const row of tx.execute(`SELECT DISTINCT actor FROM ${source}`, [])) {
      if (row.actor === null || (identity !== undefined && identity !== row.actor)) throw new Error("A database must contain exactly one recovery namespace")
      identity = row.actor
    }
    const singleton = target === "scheduler_generation"
    tx.execute(`INSERT INTO ${target}(${singleton ? "id," : ""}${columns}) SELECT ${singleton ? "1," : ""}${columns} FROM ${source}`, [])
    tx.execute(`DROP TABLE ${source}`, [])
  }
}

// syncRecoveryTransaction expires with its Grove transaction; writes to scheduled wakes mark the database for an alarm rescan (test/bun/journal.test.ts).
export function syncRecoveryTransaction(tx: Transaction, alarm: typeof Alarm.Service, identity: object): { scheduler: SchedulerTransaction; watchdog: WatchdogTransaction } {
  const io = <Value>(work: () => Value) => Effect.try({ try: work, catch: RuntimeError.from })
  const entries = <Value>(table: string, schema: Schema.Decoder<Value>, changed = () => {}) => {
    const decode = (entry: unknown) => Schema.decodeUnknownSync(schema)(JSON.parse(String(entry)))
    return {
      get: (id: string) => io(() => { const row = tx.execute(`SELECT entry FROM ${table} WHERE id=?`, [id])[0]; return row ? decode(row.entry) : undefined }),
      put: (id: string, entry: Value) => io(() => { const value = Schema.decodeUnknownSync(schema)(entry); changed(); tx.execute(`INSERT INTO ${table}(id,entry) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry`, [id, JSON.stringify(value)]) }),
      delete: (id: string) => io(() => { changed(); tx.execute(`DELETE FROM ${table} WHERE id=?`, [id]) }),
      list: io(() => new Map(tx.execute(`SELECT id,entry FROM ${table} ORDER BY id`, []).map(row => [String(row.id), decode(row.entry)]))),
    }
  }
  const wakes = entries("scheduled_wakes", ScheduledWake, () => { wakeState(identity).changed = true })
  const scheduler: SchedulerTransaction = {
    ...wakes, alarm,
    put: entry => wakes.put(entry.id, entry),
    allocateGeneration: io(() => {
      const row = tx.execute("INSERT INTO scheduler_generation(id,value) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET value=value+1 WHERE value<? RETURNING value", [Number.MAX_SAFE_INTEGER])[0]
      if (!row) throw new Error("Scheduler generation exhausted")
      return Number(row.value)
    }),
  }
  return { scheduler, watchdog: { ...entries("watchdogs", WatchdogEntry), alarm: schedulerOwner(scheduler, "watchdog", { owner: "watchdog" }) } }
}
