import { expect, spyOn, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import { durableAtom, durableMerkleAtom, value } from "../src/index"
import { createEventLog } from "../src/runtime/replay"
import { documentSession } from "../src/services/tree-state"
import { AtomState } from "../src/initialise"
import { tree, appendOnly, keyValue } from "@tardie/grove"

const Changed = Schema.Struct({ type: Schema.Literal("Changed"), key: Schema.String, text: Schema.String, remove: Schema.Boolean })
const Declared = Schema.Struct({ document: tree(Schema.Struct({ count: Schema.Int })), messages: appendOnly(Schema.Array(Schema.String)), jobs: keyValue(Schema.Struct({ text: Schema.String })) }).annotate({ title: "Collection state" })
const State: Schema.Schema<typeof Declared.Type> = Declared
const changes = fc.array(fc.record({ type: fc.constant("Changed" as const), key: fc.constantFrom("a", "b", "c"), text: fc.string(), remove: fc.boolean() }), { minLength: 2, maxLength: 20 })

test("durableAtom infers collection reducers and restores selected versions across checkpoint replay", () => {
  fc.assert(fc.property(changes, events => {
    const warnings = spyOn(console, "warn").mockImplementation(() => {})
    const positions: number[] = []
    const state = durableAtom({ name: "collections", input: Changed, schema: State, initial: { document: { count: 0 }, messages: [], jobs: {} }, reduce: (state, event, _metadata, position) => {
      // @ts-expect-error Collection inference preserves append-only edit constraints.
      expect(() => state.set(["messages", 0], "forbidden")).toThrow("Append-only")
      // @ts-expect-error Collection inference preserves whole-entry key-value edits.
      expect(() => state.set(["jobs", "a", "text"], "forbidden")).toThrow("whole-entry")
      positions.push(position)
      return state.batch(edit => {
        edit.set(["document", "count"], state.read(["document", "count"]) + 1)
        edit.append(["messages"], [event.text])
        if (event.remove) edit.remove(["jobs", event.key]); else edit.set(["jobs", event.key], { text: event.text })
      })
    } })
    const documents = documentSession({ load: () => { throw new Error("Unexpected cold read") } })
    const log = createEventLog({ schema: Changed, atoms: { state }, documents })
    let reopened: typeof log | undefined
    try {
      let current = log.initial, model: typeof State.Type = { document: { count: 0 }, messages: [], jobs: {} }
      const original = current.get(state), halfway = Math.floor(events.length / 2)
      for (const [index, event] of events.entries()) {
        current = log.append(current, event)
        const jobs = { ...model.jobs }
        if (event.remove) delete jobs[event.key]; else jobs[event.key] = { text: event.text }
        model = { document: { count: index + 1 }, messages: [...model.messages, event.text], jobs }
        expect(current.get(state).read([])).toEqual(model)
        if (index + 1 === halfway) {
          const checkpoint = current.checkpoint()!
          expect(checkpoint.durable[0]!.state).toHaveProperty("_tag", "DocumentState")
          reopened = createEventLog({ schema: Changed, atoms: { state }, documents, checkpoint })
          const resumed = reopened.replay(events.slice(halfway).map(event => ({ event })))
          expect(resumed.get(state).length(["messages"])).toBe(events.length)
        }
      }
      expect(original.read([])).toEqual({ document: { count: 0 }, messages: [], jobs: {} })
      expect(warnings).not.toHaveBeenCalled()
      expect(positions).toContain(0)
      expect(positions).toContain(events.length - 1)
    } finally { reopened?.dispose(); log.dispose(); warnings.mockRestore() }
  }), { numRuns: 40, includeErrorInReport: true })
})

test("legacy reducers retain values and codec behavior with a construction-time deprecation warning", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: -20, max: 20 }), { maxLength: 30 }), values => {
    const warnings = spyOn(console, "warn").mockImplementation(() => {})
    const Added = Schema.Struct({ type: Schema.Literal("Added"), amount: Schema.Int })
    const total = durableAtom<number, typeof Added.Type>({ name: "legacy", input: Added, schema: Schema.Int, initial: 0, reduce: (state, event) => state + event.amount })
    const tagged = durableAtom({ name: "tagged-value", input: Added, schema: value(Schema.Int), initial: 0, reduce: (state, event) => state + event.amount })
    const log = createEventLog({ schema: Added, atoms: { total, tagged } })
    try {
      const final = log.replay(values.map(amount => ({ event: { type: "Added", amount } })))
      expect(final.get(total)).toBe(values.reduce((sum, value) => sum + value, 0))
      expect(warnings).toHaveBeenCalledTimes(1)
      expect(warnings.mock.calls[0]![0]).toContain("deprecated plain state")
      expect(warnings.mock.calls[0]![0]).toContain("value(schema)")
      expect(final.get(tagged)).toBe(final.get(total))
      expect(total[AtomState].decode(7)).toBe(7)
    } finally { log.dispose(); warnings.mockRestore() }
  }))
})

test("refined scalar tree declarations keep dispatch through annotation and enforce checks", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), value => {
    const Changed = Schema.Struct({ type: Schema.Literal("Changed"), value: Schema.Int })
    const schema = tree(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({ title: "Count" })
    const state = durableAtom({ name: "count", input: Changed, schema, initial: 0, reduce: (state, event) => state.set([], event.value) })
    const log = createEventLog({ schema: Changed, atoms: { state } })
    try {
      const final = log.append(log.initial, { type: "Changed", value })
      expect(final.get(state).read([])).toBe(value)
      expect(() => log.append(final, { type: "Changed", value: -1 }).get(state)).toThrow()
    } finally { log.dispose() }
  }))
})


test("untagged array roots retain plain reducers when their element schema has metadata", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: -20, max: 20 }), { maxLength: 10 }), values => {
    const warnings = spyOn(console, "warn").mockImplementation(() => {})
    const Added = Schema.Struct({ type: Schema.Literal("Added"), value: Schema.Int })
    const state = durableAtom({ name: "array-data", input: Added, schema: Schema.Array(tree(Schema.Int)), initial: [], reduce: (state, event) => state.concat(event.value) })
    const log = createEventLog({ schema: Added, atoms: { state } })
    try {
      expect(log.replay(values.map(value => ({ event: { type: "Added", value } }))).get(state)).toEqual(values)
      expect(warnings).toHaveBeenCalledTimes(1)
    } finally { log.dispose(); warnings.mockRestore() }
  }))
})


test("null states preserve plain and declared collection dispatch", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 10 }), count => {
    const warnings = spyOn(console, "warn").mockImplementation(() => {})
    const Changed = Schema.Struct({ type: Schema.Literal("Changed") })
    const plain = durableAtom({ name: "plain-null", schema: Schema.Null, input: Changed, initial: null, reduce: state => state })
    const root = durableAtom({ name: "root-null", schema: tree(Schema.Null).annotate({ title: "Null tree" }), input: Changed, initial: null, reduce: state => state.set([], null) })
    const fields = durableAtom({ name: "field-null", schema: Schema.Struct({ value: tree(Schema.Null) }), input: Changed, initial: { value: null }, reduce: state => state.set(["value"], null) })
    const log = createEventLog({ schema: Changed, atoms: { plain, root, fields } })
    try {
      const final = log.replay(Array.from({ length: count }, () => ({ event: { type: "Changed" as const } })))
      expect(final.get(plain)).toBeNull()
      expect(final.get(root).read([])).toBeNull()
      expect(final.get(fields).read(["value"])).toBeNull()
      expect(warnings).toHaveBeenCalledTimes(1)
    } finally { log.dispose(); warnings.mockRestore() }
  }))
})


test("deprecated durableMerkleAtom preserves untagged document reducers and checkpoint replay", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: -10, max: 10 }), { minLength: 2, maxLength: 20 }), amounts => {
    const warnings = spyOn(console, "warn").mockImplementation(() => {})
    const Added = Schema.Struct({ type: Schema.Literal("Added"), amount: Schema.Int }), Value = Schema.Struct({ count: Schema.Int })
    try {
      const legacy = durableMerkleAtom<typeof Value.Type, typeof Added.Type>({ name: "legacy-merkle", input: Added, schema: Value, initial: { count: 0 }, reduce: (state, event) => state.set(["count"], state.read(["count"]) + event.amount) })
      const modern = durableAtom({ name: "declared", input: Added, schema: tree(Value), initial: { count: 0 }, reduce: (state, event) => state.set(["count"], state.read(["count"]) + event.amount) })
      const documents = documentSession({ load: () => { throw new Error("Unexpected cold read") } })
      const log = createEventLog({ schema: Added, atoms: { legacy, modern }, documents })
      let reopened: typeof log | undefined
      try {
        const halfway = Math.floor(amounts.length / 2)
        const first = log.replay(amounts.slice(0, halfway).map(amount => ({ event: { type: "Added", amount } })))
        reopened = createEventLog({ schema: Added, atoms: { legacy, modern }, documents, checkpoint: first.checkpoint()! })
        const result = reopened.replay(amounts.slice(halfway).map(amount => ({ event: { type: "Added", amount } })))
        expect(result.get(legacy).read([])).toEqual({ count: amounts.reduce((sum, value) => sum + value, 0) })
        expect(result.get(legacy).read([])).toEqual(result.get(modern).read([]))
        expect(legacy[AtomState].encode(result.get(legacy))).toEqual(modern[AtomState].encode(result.get(modern)))
        expect(warnings).toHaveBeenCalledTimes(1)
        expect(warnings.mock.calls[0]![0]).toContain("durableMerkleAtom")
      } finally { reopened?.dispose(); log.dispose() }
    } finally { warnings.mockRestore() }
  }), { numRuns: 30, includeErrorInReport: true })
})

test("whole-value atoms migrate stored tree checkpoints and resume with inline state", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 2, maxLength: 30 }), values => {
    const Event = Schema.Struct({ type: Schema.Literal("Added"), n: Schema.Int })
    const State = Schema.Struct({ count: Schema.Int, items: Schema.Array(Schema.Int) })
    const old = durableAtom({ name: "value-migration", schema: tree(State), input: Event, initial: { count: 0, items: [] }, reduce: (state, event) => state.set([], { count: state.read(["count"]) + event.n, items: [...state.read(["items"]), event.n] }) })
    const next = durableAtom({ name: "value-migration", schema: value(State), input: Event, initial: { count: 0, items: [] }, reduce: (state, event) => ({ count: state.count + event.n, items: [...state.items, event.n] }) })
    const documents = documentSession({ load: () => { throw new Error("Unexpected cold read") } })
    const events = values.map(n => ({ type: "Added" as const, n })), halfway = Math.floor(events.length / 2)
    const before = createEventLog({ schema: Event, atoms: { state: old }, documents })
    const written = before.replay(events.slice(0, halfway).map(event => ({ event })))
    const checkpoint = written.checkpoint()!
    const after = createEventLog({ schema: Event, atoms: { state: next }, checkpoint, documents })
    let restored: ReturnType<typeof createEventLog<typeof Event.Type, { state: typeof next }>> | undefined
    try {
      const completed = after.replay(events.slice(halfway).map(event => ({ event })))
      const expected = { count: values.reduce((sum, n) => sum + n, 0), items: values }
      expect(completed.get(next)).toEqual(expected)
      const inline = completed.checkpoint()!
      expect(inline.durable[0]!.state).toEqual({ _tag: "ValueState", value: expected })
      expect(inline.durable[0]!.reference).toBeUndefined()
      expect(next[AtomState].decode(inline.durable[0]!.state)).toEqual(expected)
      expect(next[AtomState].decode(expected)).toEqual(expected)
      expect(Object.isFrozen(completed.get(next).items)).toBe(true)
      restored = createEventLog({ schema: Event, atoms: { state: next }, checkpoint: JSON.parse(JSON.stringify(inline)) })
      expect(restored.initial.get(next)).toEqual(expected)
      const reader = durableAtom({ name: "value-reader", schema: tree(Schema.Int), input: Event, initial: 0, initialize: read => read("value-migration", State)?.count ?? 0, reduce: state => state })
      const derived = createEventLog({ schema: Event, atoms: { reader }, checkpoint: inline })
      try { expect(derived.initial.get(reader).read([])).toBe(expected.count) } finally { derived.dispose() }
    } finally { restored?.dispose(); after.dispose(); before.dispose() }
  }), { numRuns: 30, includeErrorInReport: true })
})
