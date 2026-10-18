import { test } from "bun:test"
import { Database } from "bun:sqlite"
import fc from "fast-check"
import { agentCollectionCases, agentCollections } from "../properties/agent-collections"

test("all agent state uses Grove and matches reducer models across SQLite recovery", () => {
  fc.assert(fc.property(agentCollectionCases, options => {
    const db = new Database(":memory:")
    try { agentCollections({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() }, options) } finally { db.close() }
  }), { numRuns: 30, includeErrorInReport: true })
}, 30000)
