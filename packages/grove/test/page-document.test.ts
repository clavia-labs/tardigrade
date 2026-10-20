import { expect, test } from "bun:test"
import fc from "fast-check"
import { documents, type Editor, type Json, type Value } from "../src/pages/document"

test("JSON reads and explicit edits match ordinary containers", () => {
  fc.assert(fc.property(fc.jsonValue(), fc.array(fc.integer(), { maxLength: 50 }), (value, items) => {
    const engine = documents({ capacity: 4, inlineBytes: 8 })
    const root = engine.from({ nested: value, items: [0, 1, 2], title: "old" })
    const next = engine.edit(root, edit => {
      edit.set(["title"], "new")
      edit.append(["items"], items)
      edit.splice(["items"], 0, 2, [-1])
      edit.set(["added"], { x: true })
      edit.remove(["nested"])
    })
    expect(engine.view(() => next).read([])).toEqual({ items: [-1, 2, ...items], title: "new", added: { x: true } })
    expect(engine.view(() => root).read([])).toEqual({ nested: value as Json, items: [0, 1, 2], title: "old" })
    expect(engine.view(() => next).slice(["items"], 0, 2)).toEqual([-1, 2])
  }), { numRuns: 100, seed: 20261024 })
})

test("pure reconciliation preserves unchanged pages without retaining materialised JSON", () => {
  let allocated = 0
  const engine = documents({ capacity: 8, allocated: () => { allocated++ } })
  const root = engine.from({ messages: Array.from({ length: 10000 }, (_, n) => ({ n })), title: "old" })
  const before = allocated
  const next = engine.reduce(root, state => ({ ...state as { messages: Json[]; title: string }, title: "new" }))
  expect(allocated - before).toBeLessThanOrEqual(2)
  expect(engine.view(() => next).read(["title"])).toBe("new")
  const identical = engine.reduce(next, state => structuredClone(state))
  expect(identical).toBe(next)
  const appended = engine.reduce(next, state => {
    const value = state as { messages: Json[]; title: string }
    return { ...value, messages: [...value.messages, { n: 10000 }] }
  })
  expect(engine.view(() => appended).length(["messages"])).toBe(10001)
  expect(engine.view(() => next).length(["messages"])).toBe(10000)
})

test("wide array splices copy tree paths while preserving the suffix", () => {
  let allocated = 0
  const engine = documents({ capacity: 8, allocated: () => { allocated++ } })
  const root = engine.from(Array.from({ length: 100000 }, (_, n) => n)), before = allocated
  const next = engine.edit(root, edit => edit.splice([], 0, 50000, [-1]))
  expect(allocated - before).toBeLessThan(100)
  expect(engine.view(() => next).length([])).toBe(50001)
  expect(engine.view(() => next).slice([], 0, 3)).toEqual([-1, 50000, 50001])
  expect(engine.view(() => root).slice([], 0, 2)).toEqual([0, 1])
})

test("path types, editor lifetimes and JSON validation are explicit", () => {
  const engine = documents(), root = engine.from({ items: [1], draft: 0 })
  let escaped: Editor | undefined
  engine.edit(root, edit => { escaped = edit })
  expect(() => escaped!.set(["draft"], 2)).toThrow("expired")
  expect(() => escaped!.append(["items"], [])).toThrow("expired")
  expect(() => engine.edit(root, edit => edit.set(["missing", "x"], 1))).toThrow()
  expect(() => engine.edit(root, edit => edit.remove(["items", 0]))).toThrow()
  expect(() => engine.edit(root, edit => edit.set(["items", 1], 2))).toThrow()
  expect(() => engine.edit(root, edit => edit.splice(["items"], 0.5, 0, []))).toThrow()
  expect(() => engine.view(() => root).read(["items", "0"])).toThrow()
  expect(() => engine.edit(root, () => 1)).toThrow()
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  const getter = Object.defineProperty({}, "x", { enumerable: true, get: () => 1 })
  for (const invalid of [NaN, Infinity, undefined, new Date(), cyclic, getter, Array(3), Object.assign([1], { extra: 2 }), { [Symbol("x")]: 1 }]) expect(() => engine.from(invalid)).toThrow()
  const unusual = JSON.parse('{"__proto__":{"x":1},"constructor":2,"":null}') as Json
  const imported: Value = engine.from(unusual)
  expect(engine.view(() => imported).read([])).toEqual(unusual)
})

test("object edits preserve insertion order and shallow frozen inputs cannot hide changed children", () => {
  const engine = documents({ capacity: 4 })
  const input = { z: { value: 1 }, a: 2 }
  const first = engine.from(Object.freeze(input))
  input.z.value = 3
  const second = engine.from(input)
  expect(engine.materialize(first)).toEqual({ z: { value: 1 }, a: 2 })
  expect(engine.materialize(second)).toEqual({ z: { value: 3 }, a: 2 })
  const edited = engine.edit(first, edit => { edit.remove(["z"]); edit.set(["z"], { value: 4 }); edit.set(["a"], 5) })
  const reordered = engine.reduce(first, () => ({ a: 2, z: { value: 1 } }))
  expect(JSON.stringify(engine.materialize(reordered))).toBe('{"a":2,"z":{"value":1}}')
  expect(JSON.stringify(engine.materialize(edited))).toBe('{"a":5,"z":{"value":4}}')
})
