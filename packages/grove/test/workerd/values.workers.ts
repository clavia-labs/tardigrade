import { env } from "cloudflare:workers"
import { evictDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import fc from "fast-check"
import type { GroveDO } from "./fixture"

const namespace = (env as { GROVE: DurableObjectNamespace<GroveDO> }).GROVE

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
