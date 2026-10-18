import { expect, test } from "bun:test"
import * as fc from "fast-check"
import type { Json } from "@tardie/grove"
import type { Tree } from "../src/storage/nodes"
import * as JsonTree from "../src/collections/tree"
import { hydrate } from "./hydrate"
import { GroveError, makeReader } from "../src/session/reader"
import { digest, descriptor } from "../src/storage/nodes"

const texts = (tree: Tree) => new Map([...tree.nodes].map(([hash, node]) => [hash, node.text]))
const load = (stored: ReadonlyMap<string, string>) => (hash: string) => stored.get(hash) ?? (() => { throw new GroveError({ message: "Missing node" }) })()

test("JSON roundtrips and immutable updates preserve earlier roots", () => {
  fc.assert(fc.property(fc.jsonValue(), raw => {
    const value = JSON.parse(JSON.stringify(raw)) as Json
    const tree = JsonTree.make({ pageItems: 3, fanout: 3, leafBytes: 64 })
    const original = tree.from(value)
    expect(tree.materialize(hydrate(original.root, texts(original)))).toEqual(value)
    expect(original.logicalBytes).toBe(Buffer.byteLength(JSON.stringify(value)))
    const changed = tree.set(original, [], { replaced: true })
    expect(tree.materialize(changed)).toEqual({ replaced: true })
    expect(tree.materialize(original)).toEqual(value)
  }), { includeErrorInReport: true, numRuns: 100 })
  const tree = JsonTree.make()
  expect(() => tree.from(NaN)).toThrow("finite")
  expect(() => tree.from(Infinity)).toThrow("finite")
  expect(() => JsonTree.make({ fanout: 1 })).toThrow("at least two")
})

test("cold and hydrated updates produce identical roots across mixed operations", () => {
  const step = fc.record({ kind: fc.constantFrom("append", "set", "field"), n: fc.nat(1000), index: fc.nat(100), count: fc.integer({ min: 1, max: 5 }) })
  fc.assert(fc.property(fc.constantFrom(2, 3, 8), fc.constantFrom(2, 3, 4), fc.constantFrom(8, 24, 64), fc.array(step, { minLength: 20, maxLength: 80 }), (pageItems, fanout, tailBytes, steps) => {
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
        cold = reader.set(current.root, ["state", "count"], step.n)
        current = tree.set(current, ["state", "count"], step.n)
      } else if (step.kind === "append" || !value.history.length) {
        const items = Array.from({ length: step.count }, (_, n) => ({ n: step.n, nested: Array.from({ length: n + step.n % 10 }, (_, i) => i) }))
        value = { ...value, history: [...value.history, ...items] }
        cold = reader.append(current.root, ["history"], items)
        current = tree.append(current, ["history"], items)
      } else {
        const index = step.index % value.history.length
        const replacement = { text: `edited ${i}`, nested: [1, 2] }
        const history = [...value.history]; history[index] = replacement
        value = { ...value, history }
        cold = reader.set(current.root, ["history", index], replacement)
        current = tree.set(current, ["history", index], replacement)
      }
      expect(cold.root).toBe(current.root)
      expect(cold.logicalBytes).toBe(Buffer.byteLength(JSON.stringify(value)))
      for (const node of cold.nodes.values()) stored.set(node.hash, node.text)
      expect(tree.materialize(hydrate(cold.root, stored))).toEqual(value)
      const start = step.index % (value.history.length + 1)
      const end = Math.min(value.history.length, start + step.count)
      expect([...reader.scan(current.root, ["history"], { start, end }, ["nested"])]).toEqual(value.history.slice(start, end).map(item => (item as { readonly nested: Json }).nested))
      expect(reader.stats().cachedBytes).toBeLessThanOrEqual(options.cacheBytes)
    }
    expect(tree.materialize(hydrate(first, stored))).toEqual({ history: [], state: { count: 0 } })
    const reader = makeReader(load(stored), options)
    expect((reader.append(current.root, ["history"], [])).root).toBe(current.root)
    const nested = reader.append(current.root, ["history", 0, "nested"], [42])
    expect(nested.root).toBe(tree.append(current, ["history", 0, "nested"], [42]).root)
  }), { includeErrorInReport: true, numRuns: 40 })
}, 30000)

test("batches preserve sequential roots across overlapping and mixed edits", () => {
  const edit = fc.record({ kind: fc.nat(6), index: fc.nat(30), value: fc.nat(1000) })
  fc.assert(fc.property(fc.constantFrom(2, 4, 16), fc.array(edit, { minLength: 1, maxLength: 60 }), (pageItems, steps) => {
    const tree = JsonTree.make({ pageItems, fanout: 3, tailBytes: 16, leafBytes: 64 })
    const initial = tree.from({ items: Array.from({ length: 32 }, (_, n) => ({ n, text: "x".repeat(80), nested: [0, 1] })), control: { a: 0, b: 0 }, added: null })
    const edits: Extract<JsonTree.Edit, { type: "set" | "append" }>[] = steps.map(({ kind, index, value }) => {
      switch (kind) {
        case 0: return { type: "set", path: ["control", "a"], value }
        case 1: return { type: "set", path: ["control"], value: { a: value, b: value } }
        case 2: return { type: "set", path: ["items", index % 32, "n"], value }
        case 3: return { type: "append", path: ["items", index % 32, "nested"], values: [value] }
        case 4: return { type: "set", path: ["added"], value: { value } }
        case 5: return { type: "append", path: ["items"], values: [{ n: value, text: "new", nested: [] }] }
        default: return { type: "set", path: ["fresh", "value"], value }
      }
    })
    edits.unshift({ type: "set", path: ["fresh"], value: { value: 0 } })
    let sequential = initial
    for (const edit of edits) sequential = edit.type === "set" ? tree.set(sequential, edit.path, edit.value) : tree.append(sequential, edit.path, edit.values)
    const batched = tree.batch(initial, edits)
    const stored = texts(initial)
    const reader = makeReader(load(stored), { pageItems, fanout: 3, tailBytes: 16, leafBytes: 64, cacheBytes: 0 })
    const cold = reader.batch(initial.root, edits)
    expect(cold.root).toBe(sequential.root)
    for (const [hash, node] of cold.nodes) stored.set(hash, node.text)
    expect(tree.materialize(hydrate(cold.root, stored))).toEqual(tree.materialize(sequential))
    expect(batched.root).toBe(sequential.root)
    expect(tree.materialize(batched)).toEqual(tree.materialize(sequential))
    expect(tree.materialize(initial)).not.toHaveProperty("fresh")
    expect(tree.batch(initial, []).root).toBe(initial.root)
  }), { includeErrorInReport: true, numRuns: 150 })
})

test("authenticated child metadata rejects arbitrary inflation on cold and warm reads", () => {
  fc.assert(fc.property(fc.array(fc.integer(), { minLength: 3, maxLength: 30 }), fc.integer({ min: 1, max: 1000 }), fc.boolean(), (values, inflation, warm) => {
    const original = JsonTree.make({ pageItems: 2, tailBytes: 2 }).from(values), stored = texts(original)
    const child = descriptor(original.node.links[0]!)
    const text = JSON.stringify([3, "a", [child[0], child[1], child[2] + inflation, child[3], child[4]]]), root = digest(text)
    stored.set(root, text)
    const reader = makeReader(load(stored), { cacheBytes: 8192 })
    if (warm) reader.read(original.root)
    expect(() => reader.read(root)).toThrow(GroveError)
    expect(() => reader.read(root)).toThrow("metadata mismatch")
    stored.set(original.root, "[]")
    expect(() => makeReader(load(stored)).read(original.root)).toThrow("corrupt")
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("repeated cache admissions count unique immutable nodes and obey arbitrary budgets", () => {
  fc.assert(fc.property(fc.jsonValue(), fc.integer({ min: 2, max: 8 }), fc.nat(8192), (raw, repetitions, cacheBytes) => {
    const value = JSON.parse(JSON.stringify(raw)) as Json, original = JsonTree.make().from(value), stored = texts(original)
    const reader = makeReader(load(stored), { cacheBytes })
    expect(Array.from({ length: repetitions }, () => reader.read(original.root))).toEqual(Array.from({ length: repetitions }, () => value))
    expect(reader.stats().cachedBytes).toBeLessThanOrEqual(cacheBytes)
    const warm = reader.stats().cachedBytes
    reader.read(original.root)
    expect(reader.stats().cachedBytes).toBe(warm)
    reader.clear()
    expect(reader.stats().cachedBytes).toBe(0)
    expect(reader.stats().cachedNodes).toBe(0)
  }), { includeErrorInReport: true, numRuns: 100 })
})
