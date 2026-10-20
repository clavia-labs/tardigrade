import { test } from "bun:test"
import { Database } from "bun:sqlite"
import fc from "fast-check"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { pageCases, pageHistory, pageUpgrade, pageHolders, pageDetached, pageAppendWork } from "./pages"
const native = (work: (driver: SyncSqlite) => void) => {
  const db = new Database(":memory:")
  try { work({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() }) } finally { db.close() }
}
test("page histories match pure reducers through rollback, retention and reopen", () => fc.assert(fc.property(pageCases, options => native(driver => pageHistory(driver, options))), { numRuns: 60, includeErrorInReport: true }))
test("legacy tree and reducer checkpoints preserve pending inputs during upgrade", () => fc.assert(fc.property(fc.string(), text => { for (const reducer of [false, true]) native(driver => pageUpgrade(driver, text, reducer)) }), { numRuns: 30, includeErrorInReport: true }))
test("peer collection preserves held drafts and rolled-back leases expire", () => native(pageHolders))

test("detached JSON survives reclamation of its source pages", () => native(pageDetached))

test("pure append shares persisted pages across placement", () => native(pageAppendWork))
