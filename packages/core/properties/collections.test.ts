import { expect, spyOn, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import { durableAtom } from "../src/atoms/durable/atom"
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
    const log = createEventLog({ schema: Added, atoms: { total } })
    try {
      const final = log.replay(values.map(amount => ({ event: { type: "Added", amount } })))
      expect(final.get(total)).toBe(values.reduce((sum, value) => sum + value, 0))
      expect(warnings).toHaveBeenCalledTimes(1)
      expect(warnings.mock.calls[0]![0]).toContain("deprecated plain state")
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
