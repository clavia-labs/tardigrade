import { isDeepStrictEqual } from "node:util"
import { Exit, Schema } from "effect"
import * as fc from "fast-check"
import { AtomState, createEventLog, durableAtom, effectAtom } from "@clavia/tardigrade-core"
import { TrajectoryState } from "@clavia/tardigrade-agent/atoms/durable/trajectory"
import { incrementalValidator } from "../../../../core/src/atoms/incremental/validate"
import { RUNTIME_PROPERTY_OPTIONS } from "./config"

const Item = Schema.Struct({ count: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)), label: Schema.NonEmptyString })
const State = Schema.Struct({ items: Schema.Array(Item) })
const Checked = Schema.Struct({ items: Schema.Array(Item).check(Schema.isMaxLength(3)), total: Schema.Finite }).check(Schema.makeFilter(value => value.total === value.items.reduce((sum, item) => sum + item.count, 0)))
const STRICT = { onExcessProperty: "error" } as const

// stateValidation compares shared-state checks with strict Effect decoding and exercises immutable reduction and restored-state validation on every host.
export function stateValidation() {
  const equivalent = (schema: Schema.Top) => {
    const fast = incrementalValidator(schema)
    const decode = Schema.decodeUnknownExit(Schema.toType(schema), STRICT)
    return (value: unknown) => {
      const valid = fast(value)
      if (valid !== Exit.isSuccess(decode(value))) throw new Error("Incremental validation differs from Effect")
      return valid
    }
  }
  const item = fc.record({ count: fc.integer({ min: 0, max: 10 }), label: fc.string({ minLength: 1, maxLength: 16 }) })
  fc.assert(fc.property(fc.array(item, { maxLength: 6 }), fc.jsonValue(), (items, arbitrary) => {
    for (const schema of [State, Checked]) {
      const compare = equivalent(schema)
      const value = (items: typeof State.Type.items) => schema === Checked ? { items, total: items.reduce((sum, item) => sum + item.count, 0) } : { items }
      let previous: typeof State.Type = { items: [] }
      for (const item of items) {
        previous = { items: [...previous.items, item] }
        compare(value(previous.items))
        for (const count of [-1, Infinity, 0.5]) compare(value([...previous.items, { ...item, count }]))
      }
      compare(arbitrary)
    }
    const compare = equivalent(TrajectoryState)
    const entry = { turnId: "turn", message: { role: "user" as const, text: "hello" } }
    const initial = { entries: [entry], models: [] }
    if (!compare(initial)) throw new Error("Valid trajectory rejected")
    for (const message of [entry.message, { ...entry.message, extra: true }, { role: "unknown" }, { role: "assistant", text: "", toolCalls: [{ callId: "call", name: "job", providerId: "test", input: arbitrary }] }]) {
      const next = { ...initial, entries: [...initial.entries, { ...entry, message }] }
      compare(next)
    }
  }), RUNTIME_PROPERTY_OPTIONS)

  const shape = Schema.Struct({ name: Schema.String })
  for (const [schema, values] of [
    [Schema.Array(Schema.String), [Array(1), [undefined], ["ok"]]],
    [shape, [{ name: "ok", [Symbol("extra")]: true }, Object.defineProperty({ name: "ok" }, "extra", { value: true }), Object.create({ name: "ok" }), {}]],
    [Schema.Struct({ name: Schema.optionalKey(Schema.String) }), [{}, { name: undefined }, { name: "ok" }]],
    [Checked, [{ items: [{ count: 1, label: "" }], total: 1 }, { items: [{ count: 1, label: "ok" }], total: 2 }]],
  ] satisfies ReadonlyArray<readonly [Schema.Top, readonly unknown[]]>) {
    const compare = equivalent(schema)
    for (const value of values) compare(value)
  }
  let checks = 0
  const counted = Schema.Struct({ name: Schema.String }).check(Schema.makeFilter(() => { checks++; return true }))
  const cached = incrementalValidator(Schema.Array(counted))
  const first = { name: "first" }
  if (!cached([first]) || !cached([first, { name: "second" }]) || checks !== 2) throw new Error("Shared subtree was revalidated")
  let fallbacks = 0
  let name: unknown = 1
  const accessor = { get name() { return name } }
  const fallback = incrementalValidator(shape, () => { fallbacks++ })
  if (fallback(accessor) || fallbacks !== 0) throw new Error("Invalid fallback emitted a warning")
  name = "ok"
  if (!fallback(accessor) || !fallback(accessor) || Number(fallbacks) !== 1) throw new Error("Valid fallback was silent or repeated its warning")
  name = 1
  if (fallback(accessor)) throw new Error("Accessor fallback reused mutable state")
  const plain = { name: "ok" }
  incrementalValidator(Schema.Unknown)({ plain, date: new Date() })
  if (Object.isFrozen(plain)) throw new Error("Fallback partially froze state")

  const errorOf = (run: () => unknown) => {
    try { run() } catch (error) { return String(error) }
    throw new Error("Invalid state was accepted")
  }
  const Added = Schema.Struct({ type: Schema.Literal("Added"), count: Schema.Finite })
  let restoreChecks = 0
  const stateSchema = State.check(Schema.makeFilter(() => { restoreChecks++; return true }))
  const state = durableAtom({ name: "test.validation", input: Added, schema: stateSchema, initial: { items: [] }, reduce: (state, event) => ({ items: [...state.items, { count: event.count, label: "ok" }] }) })
  const log = createEventLog({ schema: Added, atoms: { root: effectAtom(get => ({ view: get(state), events: {}, acts: {} })) } })
  try {
    const current = log.append(log.initial, { type: "Added", count: 1 })
    const value = current.get(state)
    restoreChecks = 0
    const restored = state[AtomState].decode(value)
    if (restoreChecks > 2) throw new Error("Restore repeated its full validation")
    if (!isDeepStrictEqual(restored, value) || !Object.isFrozen(restored)) throw new Error("Restored state differs")
    errorOf(() => Object.assign(value.items[0]!, { count: -1 }))
    if (!Object.isFrozen(log.initial.get(state).items)) throw new Error("Initial state is mutable")
    const invalid = { items: [...value.items, { count: -1, label: "ok" }] }
    const expected = errorOf(() => Schema.decodeSync(stateSchema, STRICT)(invalid))
    if (errorOf(() => log.append(current, { type: "Added", count: -1 }).get(state)) !== expected || errorOf(() => state[AtomState].decode(invalid)) !== expected) throw new Error("Invalid state lost Effect's error")
  } finally { log.dispose() }
}
