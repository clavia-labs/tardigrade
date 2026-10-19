import { Schema } from "effect"

export const ValueState = Schema.TaggedStruct("ValueState", { value: Schema.Json })
const boxed = Schema.is(ValueState)
export interface InlineTarget<Value> {
  readonly initial: (state: unknown) => Value
  readonly decode: (state: unknown) => unknown
  readonly migrate?: ((state: unknown) => unknown) | undefined
}

// openInline distinguishes typed whole-value checkpoints from schema-encoded plain checkpoints (core/properties/collections.test.ts).
export function openInline<Value>(stored: unknown, target: InlineTarget<Value>): Value {
  const inline = boxed(stored), value = inline ? stored.value : stored
  const state = target.migrate ? target.migrate(value) : value
  return target.initial(inline ? state : target.decode(state))
}

// readInline unwraps whole-value checkpoints without decoding the application's schema.
export const readInline = (stored: unknown): unknown => boxed(stored) ? stored.value : stored
