import { test } from "bun:test"
import { Database } from "bun:sqlite"
import fc from "fast-check"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { mvccCases, mvccScenario, mvccLifetimes, mvccChurn, mvccReplay, mvccCorruption, mvccForkChurn } from "./mvcc"

const native = (run: (driver: SyncSqlite) => void) => {
  const db = new Database(":memory:")
  try { run({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() }) } finally { db.close() }
}

test("MVCC histories match retained JSON versions through forks, rollback and collection", () => {
  fc.assert(fc.property(mvccCases, options => native(driver => mvccScenario(driver, options))), { numRuns: 70, includeErrorInReport: true })
})
test("MVCC held drafts survive parent acknowledgement, collection and native rollback", () => {
  fc.assert(fc.property(fc.string(), fc.constantFrom(0, 128, 8192), fc.constantFrom(1, 3, 4096), (text, cacheBytes, chunkBytes) => native(driver => mvccLifetimes(driver, text, cacheBytes, chunkBytes))), { numRuns: 50, includeErrorInReport: true })
})
test("MVCC cleanup bounds overwritten values and deleted-key churn by retained snapshots", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 40 }), fc.string(), (count, text) => native(driver => mvccChurn(driver, count, text))), { numRuns: 40, includeErrorInReport: true })
})


test("MVCC replay identities survive physical fork placement and collection", () => {
  fc.assert(fc.property(fc.string(), text => native(driver => mvccReplay(driver, text))), { numRuns: 40, includeErrorInReport: true })
})
test("MVCC readers reject missing rows, incomplete chunks and corrupt lengths", () => {
  fc.assert(fc.property(fc.string(), fc.integer({ min: 1, max: 12 }), fc.constantFrom("row", "chunk", "length"), (text, chunkBytes, mode) => native(driver => mvccCorruption(driver, text, chunkBytes, mode))), { numRuns: 50, includeErrorInReport: true })
})


test("MVCC fork cleanup removes transient tombstones and preserves inherited deletions", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 20 }), fc.string(), (count, text) => native(driver => mvccForkChurn(driver, count, text))), { numRuns: 40, includeErrorInReport: true })
})
