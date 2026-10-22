import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { RuntimeError, ScheduledWake, type Alarm, type SchedulerTransaction } from "@clavia/tardigrade-core"

// sqlSchedulerTransaction stores wake entries in the journal's SQLite transaction.
export function sqlSchedulerTransaction(sql: SqlClient.SqlClient, alarm: typeof Alarm.Service): SchedulerTransaction {
  const decode = (value: string) => Effect.try({ try: (): unknown => JSON.parse(value), catch: RuntimeError.from }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ScheduledWake)), Effect.mapError(RuntimeError.from))
  return {
    alarm,
    allocateGeneration: sql<{ value: number }>`INSERT INTO scheduler_generation (id, value) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1 WHERE value < ${Number.MAX_SAFE_INTEGER} RETURNING value`.pipe(Effect.mapError(RuntimeError.from), Effect.flatMap(rows => rows[0] ? Effect.succeed(rows[0].value) : Effect.fail(new RuntimeError("Scheduler generation exhausted")))),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: Missing scheduler entries require an undefined result.
    get: id => sql<{ entry: string }>`SELECT entry FROM scheduled_wakes WHERE id = ${id}`.pipe(Effect.mapError(RuntimeError.from), Effect.flatMap(rows => rows[0] ? decode(rows[0].entry) : Effect.succeed(undefined))),
    put: entry => sql`INSERT INTO scheduled_wakes (id, entry) VALUES (${entry.id}, ${JSON.stringify(entry)}) ON CONFLICT(id) DO UPDATE SET entry = excluded.entry`.pipe(Effect.mapError(RuntimeError.from), Effect.asVoid),
    delete: id => sql`DELETE FROM scheduled_wakes WHERE id = ${id}`.pipe(Effect.mapError(RuntimeError.from), Effect.asVoid),
    list: sql<{ entry: string }>`SELECT entry FROM scheduled_wakes`.pipe(Effect.mapError(RuntimeError.from), Effect.flatMap(rows => Effect.forEach(rows, row => decode(row.entry))), Effect.map(entries => new Map(entries.map(entry => [entry.id, entry])))),
  }
}

export const initializeSqlScheduler = (sql: SqlClient.SqlClient) => Effect.gen(function* () {
  yield* sql`CREATE TABLE IF NOT EXISTS scheduled_wakes (id TEXT PRIMARY KEY, entry TEXT NOT NULL) WITHOUT ROWID`
  yield* sql`CREATE TABLE IF NOT EXISTS scheduler_generation (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`
}).pipe(Effect.mapError(RuntimeError.from))
