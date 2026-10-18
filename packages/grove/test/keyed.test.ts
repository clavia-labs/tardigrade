import { expect, test } from "bun:test"
import * as fc from "fast-check"
import type { Json } from "@tardie/grove"
import type { Node, Tree } from "../src/storage/nodes"
import * as JsonTree from "../src/collections/tree"
import { hydrate } from "./hydrate"
import { GroveError, makeReader } from "../src/session/reader"
import { decodeNode, descriptor, digest, encodeNode } from "../src/storage/nodes"

const save = (tree: Tree, stored = new Map<string, string>()) => {
  for (const node of tree.nodes.values()) stored.set(node.hash, encodeNode(node))
  return stored
}
const readerFor = (stored: ReadonlyMap<string, string>, options = {}) => makeReader(hash => { const text = stored.get(hash); if (text === undefined) throw new GroveError({ message: "Missing node" }); return text }, { cacheBytes: 0, ...options })
const shape = (node: Node, pageItems: number, fanout: number, root = true): void => {
  if (node.tag !== "k" && node.tag !== "b") return
  expect(node.links.length).toBeLessThanOrEqual(node.tag === "k" ? pageItems : fanout)
  if (!root && fanout > 2) expect(node.links.length).toBeGreaterThanOrEqual(Math.ceil((node.tag === "k" ? pageItems : fanout) / 2))
  if (node.tag === "b") {
    for (const child of node.links) { expect(child.level).toBe(node.level - 1); shape(child, pageItems, fanout, false) }
  }
}

test("keyed cold edits preserve JSON values, enumeration order and earlier roots", () => {
  fc.assert(fc.property(fc.constantFrom(2, 3, 8), fc.constantFrom(2, 3, 8), fc.array(fc.record({ remove: fc.boolean(), key: fc.nat(80), value: fc.integer() }), { minLength: 30, maxLength: 100 }), (capacity, fanout, edits) => {
    const options = { objectPageItems: capacity, fanout, tailBytes: 8 }
    const tree = JsonTree.make(options)
    let value: Record<string, Json> = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key-${i}`, { n: i }]))
    let hot = tree.from(value)
    const first = hot.root, initial = JSON.stringify(value), stored = save(hot)
    for (const edit of edits) {
      const key = `key-${edit.key}`, reader = readerFor(stored, options)
      const cold = edit.remove ? reader.remove(hot.root, [key]) : reader.set(hot.root, [key], { n: edit.value })
      hot = edit.remove ? tree.remove(hot, [key]) : tree.set(hot, [key], { n: edit.value })
      if (edit.remove) delete value[key]
      else value[key] = { n: edit.value }
      expect(cold.root).toBe(hot.root)
      save(cold, stored)
      const hydrated = hydrate(cold.root, stored)
      shape(hydrated.node, capacity, fanout)
      expect(JSON.stringify(tree.materialize(hydrated))).toBe(JSON.stringify(value))
      expect(JSON.stringify(reader.read(cold.root))).toBe(JSON.stringify(value))
      expect(cold.logicalBytes).toBe(Buffer.byteLength(JSON.stringify(value)))
    }
    expect(JSON.stringify(tree.materialize(hydrate(first, stored)))).toBe(initial)
  }), { includeErrorInReport: true, numRuns: 40 })
}, 30000)

test("arbitrary Unicode and prototype keys preserve own-key order through removal and reinsertion", () => {
  const key = fc.oneof(fc.string(), fc.constantFrom("__proto__", "constructor", "", "2", "10", "01", "4294967294", "4294967295", "\ud800", "😀"))
  fc.assert(fc.property(fc.uniqueArray(key, { minLength: 1, maxLength: 40 }), fc.integer(), (keys, replacement) => {
    const options = { objectPageItems: 2, fanout: 3, tailBytes: 2 }, tree = JsonTree.make(options)
    const value = Object.fromEntries(keys.map((key, index) => [key, index]))
    let current = tree.from(value)
    for (const key of keys) {
      current = tree.remove(current, [key]); delete value[key]
      current = tree.set(current, [key], replacement)
      Object.defineProperty(value, key, { value: replacement, configurable: true, enumerable: true, writable: true })
      expect(JSON.stringify(tree.materialize(current))).toBe(JSON.stringify(value))
    }
    expect(JSON.stringify(readerFor(save(current)).read(current.root))).toBe(JSON.stringify(value))
    for (const key of keys) current = tree.remove(current, [key])
    expect(tree.materialize(current)).toEqual({})
    expect(current.node.level).toBe(0)
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("legacy flat manifests preserve historical roots through edits at arbitrary keys", () => {
  fc.assert(fc.property(fc.array(fc.integer(), { minLength: 40, maxLength: 100 }), fc.nat(), fc.integer(), (values, position, replacement) => {
    const stored = new Map<string, string>(), entries: [string, ReturnType<typeof descriptor>][] = []
    const expected: Record<string, Json> = {}
    values.forEach((value, index) => {
      const key = `old-${index}`, text = JSON.stringify([3, "v", value]), hash = digest(text)
      stored.set(hash, text); entries.push([key, descriptor(decodeNode(hash, text))]); expected[key] = value
      expect(encodeNode(decodeNode(hash, text))).toBe(text)
    })
    const text = JSON.stringify([3, "o", entries]), hash = digest(text); stored.set(hash, text)
    const key = `old-${position % values.length}`, before = JSON.stringify(expected)
    const changed = readerFor(stored, { objectPageItems: 3, fanout: 3, tailBytes: 2 }).set(hash, [key], replacement)
    save(changed, stored); expected[key] = replacement
    expect(JSON.stringify(readerFor(stored).read(changed.root))).toBe(JSON.stringify(expected))
    expect(JSON.stringify(readerFor(stored).read(hash))).toBe(before)
    for (const node of changed.nodes.values()) if (node.tag === "k" || node.tag === "b") expect(node.links.length).toBeLessThanOrEqual(3)
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("point edits preserve cold siblings with logarithmic traversal across generated corpus sizes", () => {
  fc.assert(fc.property(fc.integer({ min: 512, max: 10000 }), fc.nat(), fc.string({ maxLength: 100 }), (count, position, replacement) => {
    const tree = JsonTree.make(), index = position % count
    const value = Object.fromEntries(Array.from({ length: count }, (_, n) => [`job-${n}`, { text: `payload-${n}`.padEnd(1024, "x") }]))
    const original = tree.from(value), stored = save(original), reader = readerFor(stored)
    const changed = reader.set(original.root, [`job-${index}`], { text: replacement })
    expect(reader.stats().loadedNodes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(count)) + 3)
    expect(reader.stats().loadedBytes).toBeLessThan(64 * 1024)
    save(changed, stored)
    expect(readerFor(stored).read(changed.root, [`job-${index}`, "text"])).toBe(replacement)
    expect(readerFor(stored).read(original.root, [`job-${index}`, "text"])).toBe(value[`job-${index}`]!.text)
  }), { includeErrorInReport: true, numRuns: 30 })
})

test("keyed codecs reject generated duplicate ordinals, reversed keys and forged child bounds", () => {
  fc.assert(fc.property(fc.integer(), fc.integer({ min: 1, max: 10000 }), (value, inflation) => {
    const text = JSON.stringify([4, "v", value]), leaf = decodeNode(digest(text), text), ref = descriptor(leaf)
    for (const wire of [[4, "k", [["z", 0, ref], ["a", 1, ref]]], [4, "k", [["a", inflation, ref], ["b", inflation, ref]]], [4, "k", [["a", -inflation, ref]]], [3, "k", [["a", 0, ref]]]]) {
      const encoded = JSON.stringify(wire)
      expect(() => decodeNode(digest(encoded), encoded)).toThrow("keyed")
    }
    const original = JsonTree.make({ objectPageItems: 2, tailBytes: 2 }).from({ a: value, b: value, c: value }), stored = save(original)
    const children = decodeNode(original.root, stored.get(original.root)!).links.map(descriptor).map(entry => [...entry])
    children[0]![5] = Number(children[0]![5]) + inflation
    const encoded = JSON.stringify([4, "b", children]), hash = digest(encoded)
    stored.set(hash, encoded)
    expect(() => readerFor(stored).read(hash, ["a"])).toThrow("metadata mismatch")
  }), { numRuns: 100, includeErrorInReport: true })
})
