import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { test } from "vitest"
import fc from "fast-check"
import { pageCases, pageHistory, pageUpgrade, pageHolders, pageDetached, pageAppendWork } from "../pages"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import type { GroveDO } from "./fixture"
const namespace = (env as { GROVE: DurableObjectNamespace<GroveDO> }).GROVE
const native = (work: (driver: SyncSqlite) => void) => runInDurableObject(namespace.getByName(crypto.randomUUID()), (_instance, state) => work({ identity: state.storage.sql, execute: (sql, parameters) => state.storage.sql.exec(sql, ...parameters).toArray(), transaction: work => state.storage.transactionSync(work) }))
test("page histories preserve both reducer paths through native recovery", () => fc.assert(fc.asyncProperty(pageCases, options => native(driver => pageHistory(driver, options))), { numRuns: 10 }), 30_000)
test("legacy checkpoints retain unfinished inputs during page upgrades", () => fc.assert(fc.asyncProperty(fc.string(), async text => { for (const reducer of [false, true]) await native(driver => pageUpgrade(driver, text, reducer)) }), { numRuns: 10 }), 30_000)
test("peer collection preserves held drafts and expires rollback leases", () => native(pageHolders))

test("detached JSON survives reclamation of its source pages", () => native(pageDetached))

test("pure append shares persisted pages across placement", () => native(pageAppendWork))
