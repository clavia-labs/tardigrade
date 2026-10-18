import { env } from "cloudflare:workers"
import { runInDurableObject, evictDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import fc from "fast-check"
import { Schema } from "effect"
import { makeSync } from "@tardie/grove/sqlite"
import type { GroveDO } from "./fixture"

const namespace = (env as { GROVE: DurableObjectNamespace<GroveDO> }).GROVE

test("native schedules preserve accepted versions across failed edits, eviction and collection", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("seed", "seed-large", "seed-keyed"), fc.constantFrom("edit", "structure"), fc.array(fc.constantFrom("rollback", "structure-rollback", "read", "evict"), { minLength: 1, maxLength: 8 }), fc.boolean(), async (seed, edit, schedule, evict) => {
    const stub = namespace.getByName(crypto.randomUUID()), initial = await stub.valueProbe(seed)
    expect(initial.failure).toBeNull()
    let running = true
    for (const action of schedule) {
      if (action === "evict") { if (running) await evictDurableObject(stub); running = false; continue }
      const result = await stub.valueProbe(action)
      running = true
      expect(result.failure).toBe(action === "read" ? null : action === "rollback" ? "Injected commit rollback" : "Injected structural rollback")
      expect(result.messages).toEqual(initial.messages)
      expect(result.jobKeys).toEqual(initial.jobKeys)
      expect(result.nodes).toBe(initial.nodes)
      expect(result.input).toEqual(["before", "second"])
      expect(result.journalRows).toBe(1)
      if (evict) { await evictDurableObject(stub); running = false }
    }
    const result = await stub.valueProbe(edit)
    expect(result.failure).toBeNull()
    const messages = [...initial.messages!]
    if (edit === "edit") messages[0] = "corrected"
    else { messages.shift(); messages[0] = "corrected-second"; messages.push("appended") }
    expect(result.messages).toEqual(messages)
    expect(result.input).toEqual(["before", "second"])
    expect(result.journalRows).toBe(2)
    if (edit === "structure") {
      expect(result.jobKeys).toEqual([...initial.jobKeys.filter(key => key !== "first"), "next"].sort())
      expect(result.notePresent).toBe(false)
      expect(result.audit).toEqual(["structured"])
    }
    await evictDurableObject(stub)
    const reopened = await stub.valueProbe("read")
    expect(reopened.messages).toEqual(messages)
    expect(reopened.input).toEqual(["before", "second"])
    expect(await stub.valueProbe("lease")).toMatchObject({ failure: null, input: null, activeLeases: 0, leaseValue: "before", missingAfterLease: true })
    await evictDurableObject(stub)
    expect(await stub.valueProbe("release")).toMatchObject({ failure: null, current: null, nodes: 0, activeLeases: 0 })
  }), { numRuns: 20, includeErrorInReport: true, examples: [["seed", "edit", ["rollback", "evict"], true], ["seed-large", "structure", ["structure-rollback", "evict"], false], ["seed-keyed", "structure", ["structure-rollback", "read"], true]] })
}, 30000)


test("native Unicode chunks survive reopening without cache", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 16 }), fc.array(fc.constantFrom("x", "\ufeff", "\ufffe", "😀", "é"), { minLength: 1, maxLength: 40 }), async (chunkBytes, characters) => {
    const stub = namespace.getByName(crypto.randomUUID())
    await runInDurableObject(stub, (_instance, state) => {
      const driver = {
        identity: state.storage.sql,
        execute: (statement: string, parameters: readonly (string | number | null | Uint8Array)[]) => state.storage.sql.exec(statement, ...parameters).toArray(),
        transaction: <Value>(work: () => Value) => state.storage.transactionSync(work),
      }
      const options = { scope: "unicode", chunkBytes, cacheBytes: 0 }
      const store = makeSync(driver, options), value = characters.join("")
      const reference = store.capture(value)
      store.transaction(tx => store.commit(tx, { retain: [{ owner: "value", selection: reference }] }))
      store.discard()
      const reopened = makeSync(driver, options)
      expect(reopened.view(reopened.owner("value")!, Schema.String).materialize()).toBe(value)
    })
  }), { numRuns: 12, examples: [[4, ["x", "\ufeff", "\ufeff", "😀", "\ufeff"]], [4, ["\ufffe"]]], includeErrorInReport: true })
})
