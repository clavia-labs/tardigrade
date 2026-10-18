import { Schema } from "effect"
import { freezeJson, isFrozenJson, type Json } from "../storage/nodes"
import { isValue } from "../schema"
import { incrementalValidator, invalid } from "../session/validation"

export const ValueState = Schema.TaggedStruct("ValueState", { value: Schema.Json })

// bindValue validates and freezes whole JSON versions without storage or hashing (test/collections/value.test.ts).
export function bindValue<State extends Json>(schema: Schema.Decoder<State, unknown>) {
  if (!isValue(schema.ast)) throw new Error("Whole values require value(schema)")
  const validate = Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" })
  const incremental = incrementalValidator(schema)
  const check = (input: unknown): State => {
    const parsed = incremental.parse(input)
    if (parsed === invalid) { validate(input); throw new Error("Whole values require plain JSON") }
    const state = freezeJson(parsed) as State
    if (state !== null && typeof state === "object" && !isFrozenJson(state)) throw new Error("Whole values require plain JSON")
    return state
  }
  return {
    initial: (input: unknown): State => check(structuredClone(input)),
    check,
    restore: (input: unknown): State => check(Schema.decodeUnknownSync(ValueState)(input).value),
    encode: (input: unknown) => Object.freeze({ _tag: "ValueState" as const, value: check(input) }),
  }
}
