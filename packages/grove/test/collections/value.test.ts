import { expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import { bindValue, collectionSchema, value } from "@tardie/grove"

const State = value(Schema.Struct({ count: Schema.Int, items: Schema.Array(Schema.String) }))

test("whole values preserve earlier versions and round-trip through JSON without storage", () => {
  fc.assert(fc.property(fc.array(fc.string(), { maxLength: 30 }), items => {
    const binding = bindValue(State), input = { count: 0, items: [] as string[] }
    let state = binding.initial(input)
    const versions = [state]
    for (const item of items) {
      state = binding.check({ count: state.count + 1, items: [...state.items, item] })
      versions.push(state)
    }
    for (const [index, version] of versions.entries()) {
      expect(version).toEqual({ count: index, items: items.slice(0, index) })
      expect(binding.check(version)).toBe(version)
      expect(Object.isFrozen(version)).toBe(true)
      expect(Object.isFrozen(version.items)).toBe(true)
      expect(bindValue(State).restore(JSON.parse(JSON.stringify(binding.encode(version))))).toEqual(version)
    }
    expect(Object.isFrozen(input)).toBe(false)
    expect(collectionSchema(State.ast)).toBe(false)
    expect(() => binding.check({ count: "invalid", items })).toThrow()
    expect(() => binding.restore({ _tag: "ValueState", value: { count: 0, items, unexpected: true } })).toThrow()
  }), { numRuns: 50, includeErrorInReport: true })
})

test("whole-value schemas validate constraints across fields", () => {
  fc.assert(fc.property(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 0, max: 1000 }), (start, length) => {
    const binding = bindValue(value(Schema.Struct({ start: Schema.Int, end: Schema.Int }).check(Schema.makeFilter(state => state.start <= state.end))))
    const valid = binding.initial({ start, end: start + length })
    expect(binding.restore(binding.encode(valid))).toEqual(valid)
    expect(() => binding.check({ start: start + 1, end: start })).toThrow()
  }), { includeErrorInReport: true })
})

test("incremental whole-value validation skips shared subtrees and keeps schema-specific proofs", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 30 }), counts => {
    let visits = 0
    const Leaf = Schema.Int.check(Schema.makeFilter(n => { visits++; return n >= 0 }))
    const binding = bindValue(value(Schema.Struct({ branch: Schema.Struct({ n: Leaf }), count: Schema.Int })))
    let state = binding.initial({ branch: { n: 0 }, count: 0 })
    const branch = state.branch, initialVisits = visits
    for (const count of counts) {
      state = binding.check({ branch, count })
      expect(state.branch).toBe(branch)
      expect(visits).toBe(initialVisits)
    }
    expect(() => binding.check({ branch: { n: -1 }, count: 0 })).toThrow()
    const negative = bindValue(value(Schema.Struct({ n: Schema.Int }))).initial({ n: -1 })
    expect(() => bindValue(value(Schema.Struct({ n: Leaf }))).check(negative)).toThrow()
  }), { numRuns: 40, includeErrorInReport: true })
})

test("inline envelopes round-trip JSON values that resemble checkpoint descriptors", () => {
  fc.assert(fc.property(fc.jsonValue(), data => {
    const binding = bindValue(value(Schema.Json))
    for (const input of [data, { _tag: "ValueState", value: data }, { _tag: "DocumentState", reference: "data" }]) {
      expect(binding.restore(JSON.parse(JSON.stringify(binding.encode(binding.initial(input)))))).toEqual(Schema.decodeUnknownSync(Schema.Json)(input))
    }
  }), { numRuns: 40, includeErrorInReport: true })
})
