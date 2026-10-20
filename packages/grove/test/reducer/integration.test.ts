import { Database } from "bun:sqlite"
import { test } from "bun:test"
import fc from "fast-check"
import { migrationHistory } from "./integration"

test("old snapshots migrate atomically while accepted inputs survive until release", () => {
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 256 }), { minLength: 1, maxLength: 12 }), fc.boolean(), (texts, fail) => {
    const db = new Database(":memory:")
    try {
      migrationHistory({ identity: db, execute: (sql, parameters) => db.query(sql).all(...parameters) as Record<string, unknown>[], transaction: work => db.transaction(work)() }, ["\ufeff\u{1f422}".repeat(2048), ...texts], fail)
    } finally { db.close() }
  }), { seed: 20261020, numRuns: 80, includeErrorInReport: true })
})
