import { expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import * as Grove from "@tardie/grove"
import { referenceLocator } from "../src/value"

const Message = Schema.Struct({ n: Schema.Int, text: Schema.String, nested: Schema.Array(Schema.Int) })
const State = Schema.Struct({ status: Schema.String, messages: Schema.Array(Message), archive: Schema.Array(Schema.String) })
const input = (count: number) => ({ status: "ready", messages: Array.from({ length: count }, (_, n) => ({ n, text: `message ${n}`, nested: [n, n + 1] })), archive: Array.from({ length: count }, () => "x".repeat(512)) })
const fixture = (count = 100, wide = false) => {
  const stored = new Map<string, string>()
  const loads: string[] = []
  const storage = { scope: "documents/test", options: { pageItems: 2, leafBytes: 128, tailBytes: 64, cacheBytes: 0 }, load: (hash: string) => {
    loads.push(hash)
    const text = stored.get(hash)
    if (text === undefined) throw new Error("Missing node")
    return text
  } }
  const grove = Grove.make(storage)
  const value = input(count)
  if (wide) for (const message of value.messages) message.text = message.text.repeat(512)
  const original = grove.bind(State).initial(value)
  const commit = () => {
    const batch = grove.staging.prepare(), nodes = batch.nodes
    for (const [hash, node] of nodes) {
      const previous = stored.get(hash)
      if (previous !== undefined && previous !== node.text) throw new Error("Conflicting immutable write")
      stored.set(hash, node.text)
    }
    grove.staging.acknowledge(batch)
  }
  commit()
  return { stored, loads, storage, grove, original, commit }
}

test("randomized range projections match immutable JSON after later edits", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 50 }), fc.nat(), fc.nat(), (values, a, b) => {
    const storage = new Map<string, string>()
    const grove = Grove.make({ scope: "property", options: { pageItems: 2, leafBytes: 64, cacheBytes: 0 }, load: hash => storage.get(hash)! })
    const schema = Schema.Struct({ items: Schema.Array(Schema.Struct({ value: Schema.Int })) })
    const original = grove.bind(schema).initial({ items: values.map(value => ({ value })) })
    const start = a % (values.length + 1), end = start + b % (values.length - start + 1)
    const ref = grove.reference(original.selectEach(["items"], ["value"], { start, end }))
    original.append(["items"], [{ value: 999 }])
    const view = grove.view(ref, Schema.Array(Schema.Int))
    expect(view.materialize()).toEqual(values.slice(start, end))
    expect([...view.scan([])]).toEqual(values.slice(start, end))
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("references remain lazy, scoped and immutable across generated edits and reopen", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 100 }), fc.nat(), fc.nat(), fc.string(), (count, a, b, replacement) => {
    const { grove, original, storage, loads, commit } = fixture(count)
    const start = a % count, end = start + b % (count - start + 1)
    const reference = grove.reference(original.selectEach(["messages"], ["text"], { start, end }))
    const encoded = Grove.encodeReference(reference)
    const observed = loads.length
    const restored = Grove.make(storage), view = restored.view(Grove.decodeReference(encoded), Schema.Array(Schema.String))
    expect(loads.length).toBe(observed)
    expect(Object.keys(reference)).toEqual([])
    expect(() => JSON.stringify(reference)).toThrow("encodeReference")
    const next = original.set(["messages", start, "text"], replacement)
    commit()
    const expected = input(count).messages.slice(start, end).map(row => row.text)
    expect(view.materialize()).toEqual(expected)
    expect([...view.scan([])]).toEqual(expected)
    expect(view.length([])).toBe(expected.length)
    expect(() => view.read([expected.length])).toThrow()
    expect(() => view.scan([], { start: 0, end: expected.length + 1 }).next()).toThrow("range")
    expect(restored.bind(State).open(next.reference).read(["messages", start, "text"])).toBe(replacement)
    expect(() => Grove.make({ ...storage, scope: "foreign" }).view(reference, Schema.Array(Schema.String))).toThrow("scope mismatch")
    const wrong = restored.view(restored.reference(restored.bind(State).open(original.reference).select(["messages"])), Schema.Array(Schema.Int))
    expect(() => wrong.scan([]).next()).toThrow()
    expect(() => wrong.materialize()).toThrow()
    const wire = JSON.parse(encoded)
    for (const selection of [{ ...wire.selection, root: "bad" }, { ...wire.selection, path: [-1] }, { ...wire.selection, range: { start: end + 1, end } }]) expect(() => Grove.decodeReference(JSON.stringify({ ...wire, selection }))).toThrow()
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("partial scans freeze selected values and capture caller bounds without consuming later payloads", () => {
  fc.assert(fc.property(fc.integer({ min: 10, max: 200 }), fc.nat(), fc.nat(), (count, a, b) => {
    const { grove, original, storage, loads } = fixture(count)
    const restored = Grove.make(storage), view = restored.view(grove.reference(original.select([])), State)
    const start = a % count, end = start + 1 + b % (count - start)
    const path: ["messages"] = ["messages"], range = { start, end }
    const iterator = view.scan(path, range)
    range.start = 0; range.end = count; Object.assign(path, { 0: "archive" })
    expect(loads).toEqual([])
    const first = iterator.next().value!
    expect(first).toEqual(input(count).messages[start]!)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.nested)).toBe(true)
    const loaded = loads.length
    iterator.return?.()
    expect(iterator.next().done).toBe(true)
    expect(loads.length).toBe(loaded)
    expect([...view.scan(["messages"], { start, end })]).toEqual(input(count).messages.slice(start, end))
    expect(() => { for (const _ of view.scan(["messages"])) throw new Error("consumer") }).toThrow("consumer")
    expect(view.materialize()).toEqual(input(count))
    // @ts-expect-error A scalar field cannot be scanned.
    expect(() => view.scan(["status"]).next()).toThrow("array")
    // @ts-expect-error View paths are constrained by the schema.
    expect(() => view.read(["missing"])).toThrow()
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("missing and mutated backing bytes fail at observation for generated references", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 100 }), fc.string(), (count, mutation) => {
    const { grove, original, storage, stored } = fixture(count)
    const reference = grove.reference(original.select(["messages"]))
    const view = Grove.make(storage).view(reference, Schema.Array(Message))
    stored.set(referenceLocator(original.reference, storage.scope).root, mutation + " ")
    expect(() => view.scan([]).next()).toThrow()
    stored.delete(referenceLocator(original.reference, storage.scope).root)
    expect(() => Grove.make(storage).view(reference, Schema.Array(Message)).materialize()).toThrow("Missing node")
    const asynchronous = Grove.make({ ...storage, load: (async () => mutation) as never })
    expect(() => asynchronous.view(reference, Schema.Array(Message)).materialize()).toThrow("synchronously")
  }), { includeErrorInReport: true, numRuns: 100 })
})


test("immutable recognition covers generated Grove JSON without trusting foreign frozen objects", () => {
  fc.assert(fc.property(fc.record({ status: fc.string(), messages: fc.array(fc.record({ n: fc.integer(), text: fc.string(), nested: fc.array(fc.integer()) })), archive: fc.array(fc.string()) }), value => {
    const grove = Grove.make({ scope: "immutable-property", load: () => { throw new Error("Unexpected cold read") } })
    const result = grove.bind(State).initial(value).read([])
    const visit = (node: unknown) => {
      if (node === null || typeof node !== "object") return
      expect(Grove.isFrozenJson(node)).toBe(true)
      expect(Object.isFrozen(node)).toBe(true)
      for (const child of Object.values(node)) visit(child)
    }
    visit(result)
    expect(result).toEqual(value)
    expect(Grove.isFrozenJson(Object.freeze({ value }))).toBe(false)
    expect(Grove.isFrozenJson(Object.freeze(new Date(0)))).toBe(false)
  }), { includeErrorInReport: true, numRuns: 100 })
})


test("captured values match serialized JSON without editable schemas", () => {
  fc.assert(fc.property(fc.jsonValue(), input => {
    const storage = new Map<string, string>()
    const grove = Grove.make({ scope: "captured-values", load: hash => storage.get(hash)! })
    const value = Schema.decodeUnknownSync(Schema.Json)(input)
    const expected = JSON.parse(JSON.stringify(value))
    const reference = grove.capture(value)
    expect(grove.view(reference, Schema.Json).materialize()).toEqual(expected)
    const batch = grove.staging.prepare([reference])
    for (const [hash, node] of batch.nodes) storage.set(hash, node.text)
    grove.staging.acknowledge(batch)
    const reopened = Grove.make({ scope: "captured-values", load: hash => storage.get(hash)! })
    expect(reopened.view(Grove.decodeReference(Grove.encodeReference(reference)), Schema.Json).materialize()).toEqual(expected)
  }), { numRuns: 100, includeErrorInReport: true, examples: [[[-0]]] })
})

test("scoped document operations reject raw identities and foreign references before reading storage", () => {
  fc.assert(fc.property(fc.string(), fc.string(), (raw, suffix) => {
    const scope = `documents/${suffix}`
    const load = () => { throw new Error("Unexpected cold read") }
    const grove = Grove.make({ scope, load }), peer = Grove.make({ scope, load })
    const foreign = Grove.make({ scope: `foreign/${scope}`, load })
    const schema = Schema.Struct({ value: Schema.String })
    const documents = grove.bind(schema), document = documents.initial({ value: raw })
    const selection = document.select(["value"]), reference = grove.reference(selection)
    expect(grove.reference(selection)).toBe(reference)
    expect(Grove.selectionValueReference(selection)).toBe(reference)
    expect(Grove.selectionValueReference({})).toBeUndefined()
    expect(() => peer.reference(selection)).toThrow("another Grove instance")
    expect(document).not.toHaveProperty("root")
    expect(documents.open(Grove.decodeReference(Grove.encodeReference(document.reference))).read([])).toEqual(JSON.parse(JSON.stringify({ value: raw })))
    expect(grove.read(reference)).toEqual(JSON.parse(JSON.stringify(raw)))
    const root = referenceLocator(document.reference, scope).root
    // @ts-expect-error Document bindings require opaque references.
    expect(() => documents.open(root)).toThrow("Invalid Grove reference")
    // @ts-expect-error Reads require opaque references.
    expect(() => grove.read(root)).toThrow("Invalid Grove reference")
    // @ts-expect-error Byte measurement requires opaque references.
    expect(() => grove.bytes(root)).toThrow("Invalid Grove reference")
    expect(() => documents.open(reference)).toThrow("whole-document")
    expect(() => grove.bytes(reference)).toThrow("whole-document")
    expect(() => foreign.bind(schema).open(document.reference)).toThrow("scope mismatch")
    expect(() => foreign.read(reference)).toThrow("scope mismatch")
    expect(() => foreign.bytes(document.reference)).toThrow("scope mismatch")
    expect(() => foreign.hold({}, "value", reference)).toThrow("scope mismatch")
    for (const invalid of [undefined, "", " "]) expect(() => Grove.make({ load, scope: invalid as never })).toThrow("scope")
    const holder = {}
    grove.hold(holder, "value", reference)
    expect(grove.held()).toEqual([reference])
    grove.release(holder)
    expect(grove.held()).toEqual([])
  }), { numRuns: 100, includeErrorInReport: true })
})
