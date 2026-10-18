import { env } from "cloudflare:workers"
import { runInDurableObject, evictDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import fc from "fast-check"
import { Schema } from "effect"
import { makeSync } from "@tardie/grove/sqlite"
import * as JsonTree from "../../src/collections/tree"
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

test("generated cold-history edits survive eviction, rollback and collection", () => fc.assert(fc.asyncProperty(fc.integer({min:100,max:100000}), async count => {
  const stub = namespace.getByName(crypto.randomUUID())
  const original = await stub.seed(count)
  await evictDurableObject(stub)
  expect((await stub.inspect()).cache.loadedNodes).toBe(0)
  expect(await stub.append(original.root, true)).toMatchObject({ _tag: "Failure", failure: { message: "Injected rollback" } })
  expect((await stub.inspect()).root).toBe(original.root)
  expect((await stub.inspect()).events).toBe(0)
  await evictDurableObject(stub)
  const appendedResult = await stub.append(original.root)
  expect(appendedResult._tag).toBe("Success")
  if (appendedResult._tag !== "Success") throw new Error("Append failed")
  const appended = appendedResult.success
  expect(appended.loadedNodes).toBeGreaterThan(0)
  expect(appended.loadedNodes).toBeLessThan(10)
  expect(appended.loadedBytes).toBeLessThan(20000)
  expect(appended.bytes).toBeLessThan(20000)
  const tree = JsonTree.make()
  const value = { history: Array.from({ length: count }, (_, n) => ({ n, text: `message ${n}` })), archive: "x".repeat(150000) }
  expect(JSON.parse(appended.root).selection.root).toBe(tree.append(tree.from(value), ["history"], [{ n: 100000, text: "next" }]).root)
  expect(await stub.set(original.root)).toMatchObject({ _tag: "Failure", failure: { message: "Grove owner changed: checkpoint" } })
  await evictDurableObject(stub)
  const editedResult = await stub.set(appended.root)
  expect(editedResult._tag).toBe("Success")
  if (editedResult._tag !== "Success") throw new Error("Set failed")
  const edited = editedResult.success
  expect(edited.loadedNodes).toBeLessThan(10)
  await stub.collect()
  await evictDurableObject(stub)
  expect(await stub.read("pending", ["history", 0, "text"])).toMatchObject({ _tag: "Success", success: "message 0" })
  expect(await stub.readFresh("pending", ["history", 0, "text"])).toBe("message 0")
  expect(await stub.read("checkpoint", ["history", 0, "text"])).toMatchObject({ _tag: "Success", success: "edited" })
  expect(await stub.slice("checkpoint", count, count + 1)).toEqual([{ n: 100000, text: "next" }])
  expect((await stub.inspect()).cache.cachedBytes).toBeLessThanOrEqual(8192)
  await stub.release("checkpoint", edited.root)
  await stub.release("pending", original.root)
  await stub.collect()
  expect((await stub.inspect()).nodes).toBe(0)
  const corrupt = await stub.seed(4)
  await stub.corrupt()
  await evictDurableObject(stub)
  expect(await stub.read("checkpoint", [])).toMatchObject({ _tag: "Failure", failure: { message: "Node chunks missing or invalid" } })
  await stub.release("checkpoint", corrupt.root)
  await stub.release("pending", corrupt.root)
  await stub.collect()
  expect((await stub.inspect()).nodes).toBe(0)

}), {numRuns:8,includeErrorInReport:true,examples:[[100000]]}), 30000)

test("scoped references reopen stable selections after eviction and report collected storage", () => fc.assert(fc.asyncProperty(fc.integer({min:2,max:3000}), async count => {
  const stub = namespace.getByName(crypto.randomUUID())
  const original = await stub.seed(count)
  const selected = await stub.reference("checkpoint")
  expect(selected.encoded.length).toBeLessThan(512)
  expect(selected.stats.cachedBytes).toBe(0)
  expect(selected.stats.loadedNodes).toBeLessThan(10)
  await evictDurableObject(stub)
  const appended = await stub.append(original.root)
  if (appended._tag !== "Success") throw new Error("Append failed")
  const edited = await stub.set(appended.success.root)
  if (edited._tag !== "Success") throw new Error("Edit failed")
  await stub.collect()
  await evictDurableObject(stub)
  const result = await stub.readView(selected.encoded)
  expect(result).toMatchObject({ _tag: "Success", success: { first: "message 0", values: ["message 0", "message 1"], length: 2, stats: { cachedBytes: 0 } } })
  await stub.release("pending", original.root)
  await stub.release("checkpoint", edited.success.root)
  await stub.collect()
  await evictDurableObject(stub)
  expect(await stub.readView(selected.encoded)).toMatchObject({ _tag: "Failure" })
  const foreign = namespace.getByName(crypto.randomUUID())
  await foreign.seed(2)
  expect(await foreign.readView(selected.encoded)).toMatchObject({ _tag: "Failure", failure: { message: "Grove reference storage scope mismatch" } })

}), {numRuns:8,includeErrorInReport:true}), 30000)
