import { expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import * as Grove from "@tardie/grove"
import type { Json } from "@tardie/grove"
import type { Node, Tree } from "../../src/storage/nodes"
import * as JsonTree from "../../src/collections/tree"
import { hydrate } from "../hydrate"
import { GroveError, makeReader } from "../../src/session/reader"
import { decodeNode, descriptor, digest, encodeNode } from "../../src/storage/nodes"

const save = (tree: Tree, stored = new Map<string, string>()) => {
  for (const node of tree.nodes.values()) stored.set(node.hash, encodeNode(node))
  return stored
}
const load = (stored: ReadonlyMap<string, string>) => (hash: string) => stored.get(hash) ?? (() => { throw new GroveError({ message: "Missing node" }) })()
const readerFor = (stored: ReadonlyMap<string, string>, options = {}) => makeReader(load(stored), { cacheBytes: 0, ...options })
const TypedState = Schema.Struct({ count: Schema.Int, messages: Schema.Array(Schema.Struct({ text: Schema.String })) })

test("JSON roundtrips and immutable updates preserve earlier roots", () => {
  fc.assert(fc.property(fc.jsonValue(), raw => {
    const value = JSON.parse(JSON.stringify(raw)) as Json
    const tree = JsonTree.make({ pageItems: 3, fanout: 3, leafBytes: 64 })
    const original = tree.from(value)
    expect(tree.materialize(hydrate(original.root, save(original)))).toEqual(value)
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
    const stored = save(current)
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
    const stored = save(initial)
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
    const original = JsonTree.make({ pageItems: 2, tailBytes: 2 }).from(values), stored = save(original)
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
    const value = JSON.parse(JSON.stringify(raw)) as Json, original = JsonTree.make().from(value), stored = save(original)
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

const Item = Schema.Struct({ n: Schema.Int, text: Schema.String, note: Schema.optionalKey(Schema.String) })
const Job = Schema.Struct({ status: Schema.String, attempts: Schema.Int })
const State = Schema.Struct({ messages: Schema.Array(Item), audit: Schema.Array(Schema.String), jobs: Schema.Record(Schema.String, Job), label: Schema.optionalKey(Schema.String), required: Schema.String })
const fixture = () => {
  const stored = new Map<string, string>()
  const loads: string[] = []
  const grove = Grove.make({ scope: "edits", load: hash => { loads.push(hash); const text = stored.get(hash); if (text === undefined) throw new Error("Missing node"); return text }, options: { pageItems: 2, fanout: 3, leafBytes: 64, tailBytes: 16, cacheBytes: 0 } })
  const documents = grove.bind(State)
  const commit = () => { const batch = grove.staging.prepare(), nodes = batch.nodes; for (const [hash, node] of nodes) stored.set(hash, node.text); grove.staging.acknowledge(batch) }
  return { grove, documents, commit, stored, loads }
}

const sequential = (tree: ReturnType<typeof JsonTree.make>, source: ReturnType<ReturnType<typeof JsonTree.make>["from"]>, edits: readonly JsonTree.Edit[]) => {
  let next = source
  for (const edit of edits) switch (edit.type) {
    case "set": next = tree.set(next, edit.path, edit.value); break
    case "append": next = tree.append(next, edit.path, edit.values); break
    case "splice": next = tree.splice(next, edit.path, edit.index, edit.deleteCount, edit.values); break
    case "remove": next = tree.remove(next, edit.path); break
  }
  return next
}

test("randomized cold splices match JSON and retain old roots", () => {
  fc.assert(fc.property(fc.constantFrom(2, 3, 8), fc.array(fc.record({ position: fc.nat(1000), count: fc.nat(20), values: fc.array(fc.integer({ min: -99, max: 99 }), { maxLength: 8 }) }), { maxLength: 50 }), (fanout, edits) => {
    const tree = JsonTree.make({ pageItems: 2, fanout, tailBytes: 16, leafBytes: 64 })
    let expected = Array.from({ length: 40 }, (_, n) => n)
    const original = tree.from({ items: expected, untouched: "x".repeat(10000) })
    let current = original
    const stored = new Map([...original.nodes].map(([hash, node]) => [hash, node.text]))
    const reader = makeReader(hash => { const text = stored.get(hash); if (text === undefined) throw new Error("Missing node"); return text }, { pageItems: 2, fanout, tailBytes: 16, leafBytes: 64, cacheBytes: 0 })
    for (const edit of edits) {
      const index = edit.position % (expected.length + 1), count = edit.count % (expected.length - index + 1)
      const hot = tree.splice(current, ["items"], index, count, edit.values)
      const cold = reader.splice(current.root, ["items"], index, count, edit.values)
      for (const [hash, node] of cold.nodes) stored.set(hash, node.text)
      expected = [...expected.slice(0, index), ...edit.values, ...expected.slice(index + count)]
      expect(cold.root).toBe(hot.root)
      expect(tree.materialize(hydrate(cold.root, stored))).toEqual({ items: expected, untouched: "x".repeat(10000) })
      expect(tree.materialize(original)).toEqual({ items: Array.from({ length: 40 }, (_, n) => n), untouched: "x".repeat(10000) })
      current = hot
    }
    expect(reader.stats().cachedBytes).toBe(0)
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("cold mixed batches match sequential roots across keyed deletion and shifting array positions", () => {
  const operation = fc.record({ kind: fc.nat(6), position: fc.nat(100), value: fc.integer({ min: -99, max: 99 }) })
  fc.assert(fc.property(fc.array(operation, { maxLength: 50 }), steps => {
    const tree = JsonTree.make({ pageItems: 2, fanout: 3, leafBytes: 64, tailBytes: 16 })
    const original = tree.from({ items: Array.from({ length: 20 }, (_, n) => n), jobs: { a: 0, b: 1 } })
    let model: { items: number[]; jobs: Record<string, number> } = { items: Array.from({ length: 20 }, (_, n) => n), jobs: { a: 0, b: 1 } }
    const edits: JsonTree.Edit[] = []
    for (const step of steps) {
      const key = ["a", "b", "c"][step.position % 3]!
      if (step.kind < 3) {
        const index = step.position % (model.items.length + 1)
        const count = step.kind === 0 ? 0 : Math.min(step.kind, model.items.length - index)
        const values = step.kind === 2 ? [] : [step.value]
        edits.push({ type: "splice", path: ["items"], index, deleteCount: count, values })
        model.items.splice(index, count, ...values)
      } else if (step.kind === 3) {
        edits.push({ type: "remove", path: ["jobs", key] }); delete model.jobs[key]
      } else if (step.kind === 4) {
        edits.push({ type: "append", path: ["items"], values: [step.value] }); model.items.push(step.value)
      } else {
        edits.push({ type: "set", path: ["jobs", key], value: step.value }); model.jobs[key] = step.value
      }
    }
    const stored = new Map([...original.nodes].map(([hash, node]) => [hash, node.text]))
    const reader = makeReader(hash => stored.get(hash)!, { pageItems: 2, fanout: 3, leafBytes: 64, tailBytes: 16, cacheBytes: 0 })
    const batched = tree.batch(original, edits)
    const cold = reader.batch(original.root, edits)
    for (const [hash, node] of cold.nodes) stored.set(hash, node.text)
    expect(cold.root).toBe(sequential(tree, original, edits).root)
    expect(batched.root).toBe(cold.root)
    expect(tree.materialize(hydrate(cold.root, stored))).toEqual(model)
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("typed batches preserve optional fields and keyed JSON while rejecting invalid edits atomically", () => {
  const operation = fc.record({ key: fc.oneof(fc.string(), fc.constantFrom("__proto__", "constructor", "toString", "2", "01")), value: fc.string(), attempts: fc.integer(), remove: fc.boolean() })
  fc.assert(fc.property(fc.array(operation, { minLength: 1, maxLength: 50 }), steps => {
    const { grove, documents } = fixture()
    const source = { messages: [] as typeof Item.Type[], audit: [] as string[], jobs: {} as Record<string, typeof Job.Type>, required: "keep" }
    const original = documents.initial(source)
    let current = original
    const model = structuredClone(source)
    for (const step of steps) {
      current = current.batch(edit => {
        if (step.remove) edit.remove(["jobs", step.key])
        else edit.set(["jobs", step.key], { status: step.value, attempts: step.attempts })
        edit.append(["audit"], [step.value])
        edit.set(["label"], step.value)
        edit.remove(["label"])
      })
      if (step.remove) delete model.jobs[step.key]
      else Object.defineProperty(model.jobs, step.key, { value: { status: step.value, attempts: step.attempts }, enumerable: true, configurable: true, writable: true })
      model.audit.push(step.value)
      expect(JSON.stringify(current.read([]))).toBe(JSON.stringify(model))
      expect(original.read([])).toEqual(source)
      const pending = grove.stats().stagedNodes
      expect(() => current.batch(edit => { edit.append(["audit"], [step.value]); edit.set(["required"], step.attempts as never) })).toThrow()
      expect(grove.stats().stagedNodes).toBe(pending)
      // @ts-expect-error Required fields cannot be removed.
      expect(() => current.remove(["required"])).toThrow("required")
      // @ts-expect-error Array removal requires splice.
      expect(() => current.remove(["messages", 0])).toThrow("splice")
      // @ts-expect-error Optional fields cannot be assigned undefined.
      expect(() => current.set(["label"], undefined)).toThrow()
    }
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("refined containers permit whole replacements and reject partial structural edits", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 10 }), fc.integer({ min: 0, max: 100 }), (values, n) => {
    const grove = Grove.make({ scope: "refinements", load: () => { throw new Error("Missing node") } })
    const Bounded = Schema.Array(Schema.Int).check(Schema.makeFilter(items => items.length <= values.length))
    const document = grove.bind(Schema.Struct({ nested: Schema.Array(Bounded), optional: Schema.optionalKey(Schema.Int) })).initial({ nested: [values] })
    expect(() => document.append(["nested", 0], [n])).toThrow("whole-value")
    expect(() => document.splice(["nested", 0], 0, 0, [n])).toThrow("whole-value")
    expect(document.set(["nested", 0], values.slice(1)).read(["nested", 0])).toEqual(values.slice(1))
    expect(() => document.set(["nested", 0], [...values, n])).toThrow()
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("generated cold range deletions visit boundaries and leave unrelated payloads unloaded", () => {
  fc.assert(fc.property(fc.integer({ min: 1000, max: 10000 }), fc.nat(), fc.nat(), (count, a, b) => {
    const options = { pageItems: 2, fanout: 4, tailBytes: 16, leafBytes: 128, cacheBytes: 0 }, tree = JsonTree.make(options)
    const value = { items: Array.from({ length: count }, (_, n) => ({ n, text: `${n}:`.padEnd(100, "x") })), archive: "UNTOUCHED".repeat(10000) }
    const original = tree.from(value), stored = new Map([...original.nodes].map(([hash, node]) => [hash, node.text])), loaded: string[] = []
    const reader = makeReader(hash => { loaded.push(hash); return stored.get(hash)! }, options)
    const start = a % (count + 1), deleted = b % (count - start + 1)
    const changed = reader.splice(original.root, ["items"], start, deleted)
    expect(changed.root).toBe(tree.splice(original, ["items"], start, deleted).root)
    expect(loaded.every(hash => !stored.get(hash)!.includes("UNTOUCHED"))).toBe(true)
    expect(loaded.length).toBeLessThanOrEqual(4 * Math.ceil(Math.log2(count)) + 8)
    for (const [hash, node] of changed.nodes) stored.set(hash, node.text)
    expect((tree.materialize(hydrate(changed.root, stored)) as typeof value).items).toEqual([...value.items.slice(0, start), ...value.items.slice(start + deleted)])
  }), { numRuns: 30, includeErrorInReport: true })
})

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

test("typed edits match a JSON model through acknowledgement and reopen", () => {
  fc.assert(fc.property(fc.array(fc.string(), { maxLength: 20 }), fc.array(fc.record({ text: fc.string(), count: fc.integer(), replace: fc.boolean() }), { minLength: 1, maxLength: 30 }), fc.constantFrom(0, 256, 8192), (messages, steps, cacheBytes) => {
    const stored = new Map<string, string>()
    const storage = { scope: "typed", options: { pageItems: 2, leafBytes: 64, cacheBytes }, load: (hash: string) => { const text = stored.get(hash); if (text === undefined) throw new Error("Missing node"); return text } }
    const grove = Grove.make(storage), bound = grove.bind(TypedState)
    const initial = { count: 0, messages: messages.map(text => ({ text })) }
    let model = structuredClone(initial), document = bound.initial(initial)
    const original = document, old = grove.reference(original.select([]))
    for (const step of steps) {
      document = document.batch(edit => {
        edit.set(["count"], step.count)
        if (step.replace) edit.set(["messages"], [{ text: step.text }])
        else edit.append(["messages"], [{ text: step.text }])
      })
      model = { count: step.count, messages: step.replace ? [{ text: step.text }] : [...model.messages, { text: step.text }] }
      const batch = grove.staging.prepare(), nodes = batch.nodes
      for (const [hash, node] of nodes) stored.set(hash, node.text)
      grove.staging.acknowledge(batch)
      expect(document.read([])).toEqual(model)
      expect(Grove.make(storage).bind(TypedState).open(document.reference).read([])).toEqual(model)
      expect(grove.view(old, TypedState).materialize()).toEqual(initial)
      const staged = grove.stats().stagedNodes
      expect(() => document.set(["count"], step.text as never)).toThrow()
      expect(grove.stats().stagedNodes).toBe(staged)
    }
  }), { includeErrorInReport: true, numRuns: 100 })
})
