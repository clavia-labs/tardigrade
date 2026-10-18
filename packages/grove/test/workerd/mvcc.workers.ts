import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { test } from "vitest"
import fc from "fast-check"
import { mvccCases, mvccScenario, mvccLifetimes, mvccChurn, mvccReplay, mvccCorruption, mvccForkChurn } from "../mvcc"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import type { GroveDO } from "./fixture"

const namespace = (env as { GROVE: DurableObjectNamespace<GroveDO> }).GROVE
const native = (run: (driver: SyncSqlite) => void) => runInDurableObject(namespace.getByName(crypto.randomUUID()), (_instance, state) => run({ identity: state.storage.sql, execute: (sql, parameters) => state.storage.sql.exec(sql, ...parameters).toArray(), transaction: work => state.storage.transactionSync(work) }))

test("MVCC histories match retained JSON versions through forks, rollback and collection", async () => {
  await fc.assert(fc.asyncProperty(mvccCases, options => native(driver => mvccScenario(driver, options))), { numRuns: 20, includeErrorInReport: true })
}, 30000)
test("MVCC held drafts survive parent acknowledgement, collection and native rollback", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), fc.constantFrom(0, 128, 8192), fc.constantFrom(1, 3, 4096), (text, cacheBytes, chunkBytes) => native(driver => mvccLifetimes(driver, text, cacheBytes, chunkBytes))), { numRuns: 20, includeErrorInReport: true })
}, 30000)
test("MVCC cleanup bounds overwritten values and deleted-key churn by retained snapshots", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 20 }), fc.string(), (count, text) => native(driver => mvccChurn(driver, count, text))), { numRuns: 15, includeErrorInReport: true })
}, 30000)


test("MVCC replay identities survive physical fork placement and collection", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), text => native(driver => mvccReplay(driver, text))), { numRuns: 20, includeErrorInReport: true })
}, 30000)
test("MVCC readers reject missing rows, incomplete chunks and corrupt lengths", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), fc.integer({ min: 1, max: 12 }), fc.constantFrom("row", "chunk", "length"), (text, chunkBytes, mode) => native(driver => mvccCorruption(driver, text, chunkBytes, mode))), { numRuns: 20, includeErrorInReport: true })
}, 30000)


test("MVCC fork cleanup removes transient tombstones and preserves inherited deletions", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 20 }), fc.string(), (count, text) => native(driver => mvccForkChurn(driver, count, text))), { numRuns: 15, includeErrorInReport: true })
}, 30000)
