import { expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import { make } from "@tardie/grove"
import * as JsonTree from "../src/collections/tree"
import { hydrate } from "./hydrate"
import { makeReader } from "../src/session/reader"

const Item = Schema.Struct({ n: Schema.Int, text: Schema.String, note: Schema.optionalKey(Schema.String) })
const Job = Schema.Struct({ status: Schema.String, attempts: Schema.Int })
const State = Schema.Struct({ messages: Schema.Array(Item), audit: Schema.Array(Schema.String), jobs: Schema.Record(Schema.String, Job), label: Schema.optionalKey(Schema.String), required: Schema.String })
const fixture = () => {
  const stored = new Map<string, string>()
  const loads: string[] = []
  const grove = make({ scope: "edits", load: hash => { loads.push(hash); const text = stored.get(hash); if (text === undefined) throw new Error("Missing node"); return text }, options: { pageItems: 2, fanout: 3, leafBytes: 64, tailBytes: 16, cacheBytes: 0 } })
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
    const grove = make({ scope: "refinements", load: () => { throw new Error("Missing node") } })
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
