import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as fc from "fast-check"
import { JsonTree, type Json, type Tree } from "@tardie/grove"
import { GroveError, makeReader } from "@tardie/grove/effect"
import { digest, descriptor } from "../src/codec"

const texts = (tree: Tree) => new Map([...tree.nodes].map(([hash, node]) => [hash, node.text]))
const load = (stored: ReadonlyMap<string, string>) => (hash: string) => stored.has(hash) ? Effect.succeed(stored.get(hash)!) : Effect.fail(new GroveError({ message: "Missing node" }))

test("JSON roundtrips and immutable updates preserve earlier roots", () => {
  fc.assert(fc.property(fc.jsonValue(), raw => {
    const value = JSON.parse(JSON.stringify(raw)) as Json
    const tree = JsonTree.make({ pageItems: 3, fanout: 3, leafBytes: 64 })
    const original = tree.from(value)
    expect(tree.materialize(JsonTree.hydrate(original.root, texts(original)))).toEqual(value)
    expect(original.logicalBytes).toBe(Buffer.byteLength(JSON.stringify(value)))
    const changed = tree.set(original, [], { replaced: true })
    expect(tree.materialize(changed)).toEqual({ replaced: true })
    expect(tree.materialize(original)).toEqual(value)
  }), { numRuns: 100 })
  const tree = JsonTree.make()
  expect(() => tree.from(NaN)).toThrow("finite")
  expect(() => tree.from(Infinity)).toThrow("finite")
  expect(() => JsonTree.make({ fanout: 1 })).toThrow("at least two")
})

test("cold and hydrated updates produce identical roots across mixed operations", async () => {
  const step = fc.record({ kind: fc.constantFrom("append", "set", "field"), n: fc.nat(1000), index: fc.nat(100), count: fc.integer({ min: 1, max: 5 }) })
  await fc.assert(fc.asyncProperty(fc.constantFrom(2, 3, 8), fc.constantFrom(2, 3, 4), fc.constantFrom(8, 24, 64), fc.array(step, { minLength: 20, maxLength: 80 }), async (pageItems, fanout, tailBytes, steps) => {
    const options = { pageItems, fanout, leafBytes: 64, tailBytes, cacheBytes: 256 }
    const tree = JsonTree.make(options)
    let value = { history: [] as Json[], state: { count: 0 } }
    let current = tree.from(value)
    const stored = texts(current)
    const first = current.root
    for (const [i, step] of steps.entries()) {
      const reader = makeReader(load(stored), options)
      let cold: Tree
      if (step.kind === "field") {
        value = { ...value, state: { count: step.n } }
        cold = await Effect.runPromise(reader.set(current.root, ["state", "count"], step.n))
        current = tree.set(current, ["state", "count"], step.n)
      } else if (step.kind === "append" || !value.history.length) {
        const items = Array.from({ length: step.count }, (_, n) => ({ n: step.n, nested: Array.from({ length: n + step.n % 10 }, (_, i) => i) }))
        value = { ...value, history: [...value.history, ...items] }
        cold = await Effect.runPromise(reader.append(current.root, ["history"], items))
        current = tree.append(current, ["history"], items)
      } else {
        const index = step.index % value.history.length
        const replacement = { text: `edited ${i}`, nested: [1, 2] }
        const history = [...value.history]; history[index] = replacement
        value = { ...value, history }
        cold = await Effect.runPromise(reader.set(current.root, ["history", index], replacement))
        current = tree.set(current, ["history", index], replacement)
      }
      expect(cold.root).toBe(current.root)
      expect(cold.logicalBytes).toBe(Buffer.byteLength(JSON.stringify(value)))
      for (const node of cold.nodes.values()) stored.set(node.hash, node.text)
      expect(tree.materialize(JsonTree.hydrate(cold.root, stored))).toEqual(value)
      const start = step.index % (value.history.length + 1)
      const end = Math.min(value.history.length, start + step.count)
      expect(await Effect.runPromise(reader.sliceEach(current.root, ["history"], start, end, ["nested"]))).toEqual(value.history.slice(start, end).map(item => (item as { readonly nested: Json }).nested))
      expect(reader.stats().cachedBytes).toBeLessThanOrEqual(options.cacheBytes)
    }
    expect(tree.materialize(JsonTree.hydrate(first, stored))).toEqual({ history: [], state: { count: 0 } })
    const reader = makeReader(load(stored), options)
    expect((await Effect.runPromise(reader.append(current.root, ["history"], []))).root).toBe(current.root)
    const nested = await Effect.runPromise(reader.append(current.root, ["history", 0, "nested"], [42]))
    expect(nested.root).toBe(tree.append(current, ["history", 0, "nested"], [42]).root)
  }), { numRuns: 40 })
}, 30000)

test("cold 100000-message edits and reads leave unrelated subtrees unloaded", async () => {
  const tree = JsonTree.make()
  const value = { history: Array.from({ length: 100000 }, (_, n) => ({ n, text: `message ${n}` })), archive: "x".repeat(150000), state: { phase: "idle" } }
  const original = tree.from(value)
  const stored = texts(original)
  const reader = () => makeReader(load(stored), { cacheBytes: 8192 })
  const appendReader = reader()
  const appended = await Effect.runPromise(appendReader.append(original.root, ["history"], [{ n: 100000, text: "next" }]))
  expect(appended.root).toBe(tree.append(original, ["history"], [{ n: 100000, text: "next" }]).root)
  expect(appendReader.stats().loadedNodes).toBeLessThan(10)
  expect(appendReader.stats().loadedBytes).toBeLessThan(20000)
  expect(() => tree.materialize(appended)).toThrow("explicit read")
  const setReader = reader()
  const edited = await Effect.runPromise(setReader.set(original.root, ["history", 50000, "text"], "edited"))
  expect(edited.root).toBe(tree.set(original, ["history", 50000, "text"], "edited").root)
  expect(setReader.stats().loadedNodes).toBeLessThan(10)
  const fieldReader = reader()
  expect((await Effect.runPromise(fieldReader.set(original.root, ["archive"], "replaced"))).root).toBe(tree.set(original, ["archive"], "replaced").root)
  expect(fieldReader.stats().loadedNodes).toBe(1)
  const reads = reader()
  expect(await Effect.runPromise(reads.slice(original.root, ["history"], 99936, 100000))).toEqual(value.history.slice(-64))
  expect(await Effect.runPromise(reads.length(original.root, ["history"]))).toBe(100000)
  expect(await Effect.runPromise(reads.read(original.root, ["state"]))).toEqual(value.state)
  expect(reads.stats().loadedNodes).toBeLessThan(12)
  expect(reads.stats().cachedBytes).toBeLessThanOrEqual(8192)
})

test("node verification rejects corruption, unsupported formats and forged metadata", async () => {
  const tree = JsonTree.make({ pageItems: 2 })
  const original = tree.from({ history: Array.from({ length: 10 }, (_, n) => n) })
  const stored = texts(original)
  const manifest = JSON.parse(original.node.text) as [number, string, [string, [string, string, number, number, number]][]]
  manifest[2][0]![1][2]++
  const text = JSON.stringify(manifest)
  const root = digest(text)
  stored.set(root, text)
  expect(() => JsonTree.hydrate(root, stored)).toThrow("metadata mismatch")
  await expect(Effect.runPromise(makeReader(load(stored)).append(root, ["history"], [11]))).rejects.toThrow("metadata mismatch")
  const unsupported = JSON.stringify([999, "v", 1])
  expect(() => JsonTree.hydrate(digest(unsupported), new Map([[digest(unsupported), unsupported]]))).toThrow("version")
  stored.set(original.root, "[]")
  await expect(Effect.runPromise(makeReader(load(stored)).read(original.root))).rejects.toThrow("corrupt")
})

test("metadata mismatches use the typed error channel on cold and cached reads", async () => {
  const original = JsonTree.make({ pageItems: 2 }).from([1, 2, 3])
  const stored = texts(original)
  const child = descriptor(original.node.links[0]!)
  const text = JSON.stringify([3, "a", [child[0], child[1], child[2] + 1, child[3], child[4]]])
  const root = digest(text)
  stored.set(root, text)
  for (const warm of [false, true]) {
    const reader = makeReader(load(stored))
    if (warm) await Effect.runPromise(reader.read(original.root))
    const failure = await Effect.runPromise(reader.read(root).pipe(Effect.flip))
    expect(failure).toBeInstanceOf(GroveError)
    expect(failure.message).toContain("metadata mismatch")
  }
})

test("concurrent reads account for each cached node once", async () => {
  const original = JsonTree.make().from(null)
  const text = original.node.text
  const reader = makeReader(() => Effect.yieldNow.pipe(Effect.as(text)), { cacheBytes: 1024 })
  expect(await Effect.runPromise(Effect.all([reader.read(original.root), reader.read(original.root)], { concurrency: "unbounded" }))).toEqual([null, null])
  expect(reader.stats().cachedNodes).toBe(1)
  expect(reader.stats().cachedBytes).toBe(Buffer.byteLength(text))
  reader.clear()
  expect(reader.stats().cachedBytes).toBe(0)
})
