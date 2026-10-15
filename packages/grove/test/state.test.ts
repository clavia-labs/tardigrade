import { expect, test } from "bun:test"
import { Schema } from "effect"
import * as Grove from "@tardie/grove"

const State = Schema.Struct({ count: Schema.Int, messages: Schema.Array(Schema.Struct({ text: Schema.String })) })

test("typed trees preserve selected roots across edits and commit acknowledgement", () => {
  const stored = new Map<string, string>()
  const grove = Grove.make({ options: { cacheBytes: 0 }, load: hash => {
    const text = stored.get(hash)
    if (text === undefined) throw new Error("Missing node")
    return text
  } })
  const bound = grove.bind(State)
  const original = bound.initial({ count: 0, messages: [{ text: "before" }] })
  const selected = Grove.selectionReference(original.select(["messages"]))!
  const texts = Grove.selectionReference(original.selectEach(["messages"], ["text"]))!
  const first = grove.nodes()
  const next = original.append(["messages"], [{ text: "after" }]).set(["count"], 1)
  for (const [hash, node] of grove.nodes()) stored.set(hash, node.text)
  grove.committed(first)
  expect(grove.nodes().size).toBeGreaterThan(0)
  grove.committed(grove.nodes())
  expect(grove.nodes().size).toBe(0)
  expect(grove.read(selected.root, selected.path)).toEqual([{ text: "before" }])
  expect(grove.readReference(texts)).toEqual(["before"])
  expect(bound.open(next.root).read(["count"])).toBe(1)
  expect(next.slice(["messages"], 1, 2)).toEqual([{ text: "after" }])
  expect(next.length(["messages"])).toBe(2)
  expect(() => next.set(["count"], "bad" as never)).toThrow()
  expect(() => next.append(["messages"], [{ text: 1 } as never])).toThrow()
  expect(() => next.read(["messages", 9])).toThrow()
  expect(() => grove.bind(State).check(next)).toThrow("foreign tree")
  expect(Grove.selectionReference({ root: original.root, path: [] })).toBeUndefined()
})

test("tree schemas reject refinements requiring sibling validation", () => {
  expect(() => Grove.treeSchema(State.check(Schema.makeFilter(() => true)).ast)).toThrow("container checks")
  expect(() => Grove.treeSchema(Schema.Struct({ optional: Schema.optionalKey(Schema.String) }).ast)).toThrow("fixed fields")
})

test("nullable fields validate whole replacements", () => {
  const grove = Grove.make({ load: () => { throw new Error("Missing node") } })
  const state = grove.bind(Schema.Struct({ pending: Schema.NullOr(Schema.Struct({ id: Schema.String })) })).initial({ pending: null })
  const next = state.set(["pending"], { id: "call" })
  expect(next.read(["pending"])).toEqual({ id: "call" })
  expect(() => next.set(["pending", "id"] as never, "new" as never)).toThrow("Invalid schema path")
  expect(() => next.set(["pending"], { id: 1 } as never)).toThrow()
})

test("rich messages validate atomically and preserve container refinements", () => {
  const Message = Schema.Union([Schema.Struct({ role: Schema.Literal("user"), text: Schema.String }), Schema.Struct({ role: Schema.Literal("tool"), value: Schema.Json, note: Schema.optionalKey(Schema.String) })])
  const grove = Grove.make({ load: () => { throw new Error("Missing node") } })
  const state = grove.bind(Schema.Struct({ messages: Schema.Array(Message) })).initial({ messages: [] })
  const next = state.append(["messages"], [{ role: "tool", value: { nested: [1, true] } }])
  expect(next.read(["messages"])).toEqual([{ role: "tool", value: { nested: [1, true] } }])
  expect(() => next.append(["messages"], [{ role: "tool" } as never])).toThrow()
  const Refined = Schema.Struct({ a: Schema.Int, b: Schema.Int }).check(Schema.makeFilter(value => value.a <= value.b))
  const refined = grove.bind(Schema.Struct({ rows: Schema.Array(Refined) })).initial({ rows: [{ a: 1, b: 2 }] })
  expect(() => refined.set(["rows", 0, "a"], 3)).toThrow("whole-value")
  expect(() => refined.set(["rows", 0], { a: 3, b: 2 })).toThrow()
})
