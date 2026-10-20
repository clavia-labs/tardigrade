import { expect, test } from "bun:test"
import fc from "fast-check"
import { document, type Json } from "./json"

test("JSON round trips through keyed objects and ranked arrays", () => {
  fc.assert(fc.property(fc.json().map(value => JSON.parse(value) as Json), value => {
    const doc = document({ capacity: 4 })
    expect(doc.materialize(doc.from(value))).toEqual(value)
  }), { numRuns: 200, seed: 20261020 })
})

test("JSON edits retain snapshots and share untouched containers", () => {
  const doc = document({ capacity: 4 })
  const initial = { users: [{ name: "Ada" }, { name: "Lin" }], settings: { theme: "dark" } }
  const root = doc.from(initial)
  const renamed = doc.set(root, ["users", 0, "name"], "Grace")
  expect(doc.get(renamed, ["settings"])).toBe(doc.get(root, ["settings"]))
  expect(doc.get(renamed, ["users", 1])).toBe(doc.get(root, ["users", 1]))
  expect(doc.materialize(root)).toEqual(initial)
  const inserted = doc.splice(renamed, ["users"], 1, 0, [{ name: "Edsger" }])
  expect(doc.get(inserted, ["users", 2])).toBe(doc.get(root, ["users", 1]))
  const appended = doc.append(inserted, ["users"], [{ name: "Barbara" }])
  const removed = doc.remove(appended, ["settings", "theme"])
  expect(doc.materialize(removed)).toEqual({ users: [{ name: "Grace" }, { name: "Edsger" }, { name: "Lin" }, { name: "Barbara" }], settings: {} })
  expect(doc.set(root, ["users", 0, "name"], "Ada")).toBe(root)
  expect(doc.remove(root, ["absent"])).toBe(root)
  expect(doc.append(root, ["users"], [])).toBe(root)
  expect([...doc.elements(doc.get(inserted, ["users"])!, 1, 2)].map(doc.materialize)).toEqual([{ name: "Edsger" }])
  expect([...doc.fields(root)].map(([key]) => key)).toEqual(["settings", "users"])
  expect(doc.materialize(doc.set(root, [], 42))).toBe(42)
  initial.users[0]!.name = "mutated"
  expect(doc.get(root, ["users", 0, "name"])).toBe("Ada")
})

test("generated JSON array edits agree with native splice", () => {
  fc.assert(fc.property(fc.array(fc.record({ start: fc.nat(1000), count: fc.nat(100), items: fc.array(fc.json().map(value => JSON.parse(value) as Json), { maxLength: 10 }) }), { maxLength: 100 }), edits => {
    const doc = document({ capacity: 3 })
    let root = doc.from({ values: [] }), model: Json[] = []
    for (const edit of edits) {
      const start = edit.start % (model.length + 1), count = Math.min(edit.count, model.length - start)
      root = doc.splice(root, ["values"], start, count, edit.items)
      model.splice(start, count, ...edit.items)
      expect(doc.materialize(root)).toEqual({ values: model })
    }
  }), { numRuns: 100, seed: 20261020 })
}, 30_000)

test("JSON enforces container paths and valid JSON inputs", () => {
  const doc = document(), root = doc.from({ array: [null], scalar: 1 })
  expect(doc.get(root, ["missing"])).toBeUndefined()
  expect(() => doc.set(root, ["missing", "field"], 1)).toThrow(RangeError)
  expect(() => doc.set(root, ["scalar", "field"], 1)).toThrow(TypeError)
  expect(() => doc.set(root, ["array", "0"], 1)).toThrow(TypeError)
  expect(() => doc.set(root, ["array", 1], 1)).toThrow(RangeError)
  expect(() => doc.remove(root, ["array", 0])).toThrow(TypeError)
  expect(() => doc.remove(root, [])).toThrow(TypeError)
  expect(() => doc.splice(root, ["missing"], 0, 0)).toThrow(TypeError)
  for (const invalid of [NaN, Infinity, new Date(), [undefined], Array(1)]) expect(() => doc.from(invalid as Json)).toThrow(TypeError)
  expect(() => doc.splice(root, ["array"], 0, 0, Array(1) as Json[])).toThrow(TypeError)
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic
  expect(() => doc.from(cyclic as Json)).toThrow(TypeError)
  const special = JSON.parse('{"__proto__":{"polluted":true},"constructor":null}') as Json
  const result = doc.materialize(doc.from(special))
  expect(result).toEqual(special)
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
})
