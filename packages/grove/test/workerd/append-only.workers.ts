import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { test } from "vitest"
import fc from "fast-check"
import { appendCases, appendOnlyScenario, rowCases, rowLogScenario, rowCorruptionScenario } from "../append-only"
import type { GroveDO } from "./fixture"

const namespace = (env as { GROVE: DurableObjectNamespace<GroveDO> }).GROVE

test("append-only native histories match immutable JSON versions", async () => {
  await fc.assert(fc.asyncProperty(appendCases, async options => {
    await runInDurableObject(namespace.getByName(crypto.randomUUID()), (_instance, state) => {
      appendOnlyScenario({ identity: state.storage.sql, execute: (sql, parameters) => state.storage.sql.exec(sql, ...parameters).toArray(), transaction: work => state.storage.transactionSync(work) }, options)
    })
  }), { numRuns: 20, includeErrorInReport: true })
}, 30000)


test("row versions retain draft dependencies and replay identity across prefix reuse", async () => {
  await fc.assert(fc.asyncProperty(rowCases, async options => {
    await runInDurableObject(namespace.getByName(crypto.randomUUID()), (_instance, state) => {
      rowLogScenario({ identity: state.storage.sql, execute: (sql, parameters) => state.storage.sql.exec(sql, ...parameters).toArray(), transaction: work => state.storage.transactionSync(work) }, options)
    })
  }), { numRuns: 20, includeErrorInReport: true })
}, 30000)


test("row readers reject generated missing entries, broken chunks and wrong lengths", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), fc.integer({ min: 1, max: 12 }), fc.constantFrom("row", "chunk", "length"), async (suffix, chunkBytes, mode) => {
    await runInDurableObject(namespace.getByName(crypto.randomUUID()), (_instance, state) => {
      rowCorruptionScenario({ identity: state.storage.sql, execute: (sql, parameters) => state.storage.sql.exec(sql, ...parameters).toArray(), transaction: work => state.storage.transactionSync(work) }, suffix, chunkBytes, mode)
    })
  }), { numRuns: 20, includeErrorInReport: true })
}, 30000)
