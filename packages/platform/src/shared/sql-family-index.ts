import { RuntimeError, journalCall, type FamilyRecord, type JournalFamily, type Recorded } from "@clavia/tardigrade-core"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

export const DEFAULT_FAMILY_INDEX_BATCH_SIZE = 16

export interface FamilyIndexOptions {
  readonly familyIndexBatchSize?: number | undefined
}

export const initializeSqlFamilyIndex = (sql: SqlClient.SqlClient) => Effect.gen(function* () {
  yield* sql`CREATE TABLE IF NOT EXISTS experimental_journal_keys (actor TEXT NOT NULL, family TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (actor, family, key, seq), FOREIGN KEY (actor, seq) REFERENCES experimental_events(actor, seq)) WITHOUT ROWID`
  yield* sql`CREATE TABLE IF NOT EXISTS experimental_journal_family_index (actor TEXT NOT NULL, family TEXT NOT NULL, version TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (actor, family)) WITHOUT ROWID`
})

// sqlFamilyIndex maintains derived family keys and resumable backfill cursors over journal records.
export function sqlFamilyIndex<Event extends object>(options: {
  readonly actor: string
  readonly batchSize: number
  readonly readRecord: (sql: SqlClient.SqlClient, row: { seq: number; event: string }) => Effect.Effect<Recorded<Event>, Error>
  readonly transaction: <Value>(sql: SqlClient.SqlClient, work: Effect.Effect<Value, Error>) => Effect.Effect<Value, Error>
}) {
  const { actor, batchSize, readRecord, transaction } = options
  const families = new Map<string, JournalFamily>()
  const index = (sql: SqlClient.SqlClient, family: JournalFamily, position: number, record: Recorded<Event>) => Effect.gen(function* () {
    const key = yield* journalCall(() => family.key(record, position))
    if (key === undefined) return
    if (typeof key !== "string") return yield* Effect.fail(new RuntimeError("Journal family keys must be strings or undefined"))
    yield* sql`INSERT INTO experimental_journal_keys (actor, family, key, seq) VALUES (${actor}, ${family.name}, ${key}, ${position})`
  })
  const prepare = (sql: SqlClient.SqlClient, family: JournalFamily, length: number) => Effect.gen(function* () {
    if (!family.name.trim() || !family.indexVersion.trim()) return yield* Effect.fail(new RuntimeError("Journal family name and indexVersion must be nonempty"))
    families.set(family.name, family)
    let done = false
    while (!done) {
      done = yield* transaction(sql, Effect.gen(function* () {
        const rows = yield* sql<{ version: string; position: number }>`SELECT version, position FROM experimental_journal_family_index WHERE actor = ${actor} AND family = ${family.name}`
        const existing = rows[0]
        let position = existing?.position ?? 0
        if (existing?.version === family.indexVersion && position === length) return true
        if (!existing || existing.version !== family.indexVersion) {
          yield* sql`DELETE FROM experimental_journal_keys WHERE actor = ${actor} AND family = ${family.name}`
          position = 0
        }
        if (!Number.isSafeInteger(position) || position < 0 || position > length) return yield* Effect.fail(new RuntimeError("Invalid family index position"))
        const events = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${actor} AND seq >= ${position} AND seq < ${length} ORDER BY seq LIMIT ${batchSize}`
        if (events.length !== Math.min(batchSize, length - position)) return yield* Effect.fail(new RuntimeError("Family index journal range is unavailable"))
        for (const [offset, row] of events.entries()) {
          if (row.seq !== position + offset || typeof row.event !== "string") return yield* Effect.fail(new RuntimeError("Invalid family index journal sequence"))
          yield* index(sql, family, row.seq, yield* readRecord(sql, row))
        }
        position += events.length
        yield* sql`INSERT INTO experimental_journal_family_index (actor, family, version, position) VALUES (${actor}, ${family.name}, ${family.indexVersion}, ${position}) ON CONFLICT(actor, family) DO UPDATE SET version = excluded.version, position = excluded.position`
        return position === length
      }))
    }
  })
  return {
    get size() { return families.size },
    prepare,
    catchUp: (sql: SqlClient.SqlClient, length: number) => Effect.forEach(families.values(), family => prepare(sql, family, length), { discard: true }),
    append: (sql: SqlClient.SqlClient, position: number, records: readonly Recorded<Event>[]) => Effect.gen(function* () {
      for (const family of families.values()) {
        const indexed = yield* sql<{ version: string; position: number }>`SELECT version, position FROM experimental_journal_family_index WHERE actor = ${actor} AND family = ${family.name}`
        if (indexed[0]?.version !== family.indexVersion || indexed[0].position !== position) return yield* Effect.fail(new RuntimeError("Family index does not cover the committed journal prefix"))
        for (const [offset, record] of records.entries()) yield* index(sql, family, position + offset, record)
        yield* sql`UPDATE experimental_journal_family_index SET position = ${position + records.length} WHERE actor = ${actor} AND family = ${family.name}`
      }
    }),
    readPage: (sql: SqlClient.SqlClient, family: JournalFamily, key: string, from: number, to: number, order: "asc" | "desc" = "asc"): Effect.Effect<readonly FamilyRecord<Recorded<Event>>[], Error> => transaction(sql, Effect.gen(function* () {
      const indexed = yield* sql<{ version: string; position: number }>`SELECT version, position FROM experimental_journal_family_index WHERE actor = ${actor} AND family = ${family.name}`
      if (indexed[0]?.version !== family.indexVersion || indexed[0].position < to) return yield* Effect.fail(new RuntimeError("Family index does not cover the requested journal range"))
      const rows = order === "asc"
        ? yield* sql<{ seq: number; event: string | null }>`SELECT k.seq, e.event FROM experimental_journal_keys k LEFT JOIN experimental_events e ON e.actor = k.actor AND e.seq = k.seq WHERE k.actor = ${actor} AND k.family = ${family.name} AND k.key = ${key} AND k.seq >= ${from} AND k.seq < ${to} ORDER BY k.seq LIMIT ${batchSize}`
        : yield* sql<{ seq: number; event: string | null }>`SELECT k.seq, e.event FROM experimental_journal_keys k LEFT JOIN experimental_events e ON e.actor = k.actor AND e.seq = k.seq WHERE k.actor = ${actor} AND k.family = ${family.name} AND k.key = ${key} AND k.seq >= ${from} AND k.seq < ${to} ORDER BY k.seq DESC LIMIT ${batchSize}`
      return yield* Effect.forEach(rows, row => Effect.gen(function* () {
        if (!Number.isSafeInteger(row.seq) || row.seq < from || row.seq >= to || row.event === null) return yield* Effect.fail(new RuntimeError("Family index is missing journal records"))
        const record = yield* readRecord(sql, { seq: row.seq, event: row.event })
        if ((yield* journalCall(() => family.key(record, row.seq))) !== key) return yield* Effect.fail(new RuntimeError("Family index differs from its journal record"))
        return { position: row.seq, record }
      }))
    })),
    readKeys: (sql: SqlClient.SqlClient, family: JournalFamily, after: string | undefined, limit: number, position: number) => transaction(sql, Effect.gen(function* () {
      const indexed = yield* sql<{ version: string; position: number }>`SELECT version, position FROM experimental_journal_family_index WHERE actor = ${actor} AND family = ${family.name}`
      if (indexed[0]?.version !== family.indexVersion || indexed[0].position < position) return yield* Effect.fail(new RuntimeError("Family index does not cover the requested key range"))
      const rows = after === undefined
        ? yield* sql<{ key: string }>`SELECT DISTINCT key FROM experimental_journal_keys WHERE actor = ${actor} AND family = ${family.name} AND seq < ${position} ORDER BY key LIMIT ${limit}`
        : yield* sql<{ key: string }>`SELECT DISTINCT key FROM experimental_journal_keys WHERE actor = ${actor} AND family = ${family.name} AND key > ${after} AND seq < ${position} ORDER BY key LIMIT ${limit}`
      return rows.map(row => row.key)
    })),
  }
}
