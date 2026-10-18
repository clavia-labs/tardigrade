import { Database } from "bun:sqlite"
import type { SqliteHarness } from "../../properties/integration"

export const withSqlite: SqliteHarness = async check => {
  const db = new Database(":memory:")
  try { await check({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() }) } finally { db.close() }
}
