import { test } from "bun:test"
import { Database } from "bun:sqlite"
import { storageProperties, type SqliteHarness } from "./properties"

const native: SqliteHarness = check => {
  const db = new Database(":memory:")
  try { check({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() }) } finally { db.close() }
}

for (const property of storageProperties) test(property.name, () => property.run(native, property.bunRuns), 30_000)
