import { test } from "bun:test"
import { Database } from "bun:sqlite"
import fc from "fast-check"
import { eventLogCases, eventLogCompatibility } from "../properties/event-log-compatibility"

test("0.50 event tables and row bytes survive Grove publication, rollback and reopen", async () => {
  await fc.assert(fc.asyncProperty(eventLogCases, async options => {
    const db = new Database(":memory:")
    try { await eventLogCompatibility({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() }, options) } finally { db.close() }
  }), { numRuns: 30, includeErrorInReport: true })
}, 30000)
