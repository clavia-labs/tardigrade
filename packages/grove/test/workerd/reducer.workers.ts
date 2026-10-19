import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { test, expect } from "vitest"
import fc from "fast-check"
import type { GroveDO } from "./fixture"
import { migrationHistory } from "../reducer/integration"

const namespace = (env as { GROVE: DurableObjectNamespace<GroveDO> }).GROVE

test("native plain reducers migrate old inputs and reclaim legacy materialisations", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string({ maxLength: 128 }), { minLength: 1, maxLength: 6 }), fc.boolean(), async (texts, fail) => {
    const stub = namespace.getByName(crypto.randomUUID())
    const result = await runInDurableObject(stub, (_instance, state) => migrationHistory({
      identity: state.storage.sql,
      execute: (sql, parameters) => state.storage.sql.exec(sql, ...parameters).toArray(),
      transaction: work => state.storage.transactionSync(work),
    }, ["\ufeff\u{1f422}".repeat(2048), ...texts], fail))
    expect(result).toMatchObject({ oldInputStable: true, coldRestore: true, rollback: fail, logUnchanged: true, legacyReclaimed: true })
  }), { numRuns: 12, seed: 20261020, examples: [[["retained input"], true]] })
})
