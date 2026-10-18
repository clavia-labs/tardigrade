import { env } from "cloudflare:workers"
import { evictDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import fc from "fast-check"
import * as JsonTree from "../../src/collections/tree"
import type { GroveDO } from "./fixture"

const namespace = (env as { GROVE: DurableObjectNamespace<GroveDO> }).GROVE

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
