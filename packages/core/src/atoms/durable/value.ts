import { durableProjection } from "./projection"
import { Schema, SchemaAST } from "effect"
import { incrementalDecoder } from "../incremental/decode"
import { frozenPlainData } from "../incremental/frozen"
import { incrementalValidator, invalid } from "../incremental/validate"
import type { RecordMetadata } from "../../services/journal"
import type { DurableAtom } from "./atom"

// valueAtom folds matching input events into validated state and supplies their zero-based journal positions. Schemas must be pure; reducers preserve unchanged references and leave published state unchanged. Plain-data states are frozen (packages/platform/test/properties/runtime/state-validation.ts).
export function valueAtom<State, Event>(options: {
  readonly name: string
  readonly input: Schema.Schema<Event>
  readonly schema: Schema.Schema<State>
  readonly initial: NoInfer<State>
  readonly reduce: (state: NoInfer<State>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<State>
}): DurableAtom<State, Event> {
  if (!options.name.trim()) throw new Error("Durable atom name must not be empty")
  console.warn(`durableAtom "${options.name}" uses deprecated plain state; wrap its schema in value(schema) for whole-value state, or declare tree, appendOnly or keyValue collections`)
  const validate = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })
  const fast = incrementalValidator(options.schema, () => console.warn(`Durable atom "${options.name}" state is not plain data; validation is O(state)`))
  // check returns the state to keep: the parsed value when the incremental path accepts it, otherwise state after Effect's validation.
  const check = (state: State): State => {
    const parsed = fast.parse(state)
    if (parsed !== invalid) return parsed as State
    validate(state)
    return state
  }
  const decode = (Schema.decodeUnknownSync as unknown as (schema: unknown, options: { readonly onExcessProperty: "error" }) => (value: unknown) => unknown)(options.schema, { onExcessProperty: "error" }) as (value: unknown) => State
  const encode = (Schema.encodeUnknownSync as unknown as (schema: unknown) => (value: unknown) => unknown)(options.schema) as (value: State) => unknown
  // encodeFrozen preserves subtree identity when reversing the schema leaves its AST unchanged (properties/durable-state.test.ts).
  const encodeFrozen = SchemaAST.flip(options.schema.ast) === options.schema.ast ? incrementalDecoder(options.schema) : undefined
  const restore = (state: unknown): State => {
    const decoded = decode(state)
    return fast.trust(decoded) as State
  }
  const initial = structuredClone(options.initial)
  validate(initial)
  check(initial)
  return durableProjection(options, {
    initial: () => check(structuredClone(initial)),
    restore: state => restore(state), check,
    state: { name: options.name, decode: restore, encode: (value: unknown) => typeof value === "object" && value !== null && frozenPlainData.has(value) ? encodeFrozen?.(value)?.value ?? encode(value as State) : encode(value as State) },
  })
}
