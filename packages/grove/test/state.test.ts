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


test("selected ranges survive edits, commit release and a fresh reader", () => {
  const stored = new Map<string, string>()
  const options = { pageItems: 2, leafBytes: 128, cacheBytes: 0 }
  const storage = { options, load: (hash: string) => { const text = stored.get(hash); if (text === undefined) throw new Error("Missing node"); return text } }
  const grove = Grove.make(storage)
  const initial = grove.bind(State).initial({ count: 0, messages: Array.from({ length: 12 }, (_, n) => ({ text: `message ${n}` })) })
  const selected = Grove.selectionReference(initial.selectEach(["messages"], ["text"], { start: 3, end: 7 }))!
  const next = initial.append(["messages"], [{ text: "new" }]).set(["messages", 4, "text"], "changed")
  const nodes = grove.nodes([initial.root, next.root])
  for (const [hash, node] of nodes) stored.set(hash, node.text)
  grove.committed(nodes)
  expect(grove.nodes().size).toBe(0)
  const restored = Grove.make(storage)
  expect(restored.readReference(selected)).toEqual(["message 3", "message 4", "message 5", "message 6"])
  expect(restored.bind(State).open(next.root).read(["messages", 4, "text"])).toBe("changed")
  expect(restored.stats().cachedBytes).toBe(0)
  expect(() => initial.selectEach(["messages"], ["text"], { start: 4, end: 3 })).toThrow("range")
  expect(() => initial.selectEach(["messages"], ["text"], { start: 0, end: 13 })).toThrow("range")
})

test("typed batches publish a final root atomically and preserve frozen selections", () => {
  const stored = new Map<string, string>()
  const storage = { options: { pageItems: 2, tailBytes: 16, leafBytes: 64, cacheBytes: 0 }, load: (hash: string) => { const text = stored.get(hash); if (text === undefined) throw new Error("Missing node"); return text } }
  const grove = Grove.make(storage)
  const initial = grove.bind(State).initial({ count: 0, messages: Array.from({ length: 100 }, (_, n) => ({ text: `message ${n}` })) })
  const selected = Grove.selectionReference(initial.selectEach(["messages"], ["text"], { start: 0, end: 2 }))!
  const first = grove.nodes([initial.root])
  for (const [hash, node] of first) stored.set(hash, node.text)
  grove.committed(first)
  const next = initial.batch(edit => {
    edit.set(["count"], 1)
    edit.set(["messages", 0, "text"], "changed")
    edit.append(["messages"], [{ text: "new" }])
    edit.set(["messages", 100, "text"], "newer")
  })
  expect(next.root).toBe(initial.set(["count"], 1).set(["messages", 0, "text"], "changed").append(["messages"], [{ text: "new" }]).set(["messages", 100, "text"], "newer").root)
  const before = [...grove.nodes().keys()]
  expect(() => initial.batch(edit => { edit.set(["count"], 2); edit.set(["messages", 999, "text"], "invalid") })).toThrow()
  expect([...grove.nodes().keys()]).toEqual(before)
  expect(() => initial.batch(edit => { edit.set(["count"], "invalid" as never) })).toThrow()
  expect(() => initial.batch((async () => {}) as never)).toThrow("synchronous")
  expect(initial.batch(() => {})).toBe(initial)
  const nodes = grove.nodes([initial.root, next.root])
  for (const [hash, node] of nodes) stored.set(hash, node.text)
  grove.committed(nodes)
  const reopened = Grove.make(storage)
  expect(reopened.readReference(selected)).toEqual(["message 0", "message 1"])
  const restored = reopened.bind(State).open(next.root)
  expect(restored.read(["count"])).toBe(1)
  expect(restored.read(["messages", 100, "text"])).toBe("newer")
  expect(reopened.stats().cachedBytes).toBe(0)
})
