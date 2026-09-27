import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { durableAtom } from "./durable"
import { EffectRef, effectKey } from "./internal/effects"
import { RuntimeError } from "./errors"

export type PromiseState<Value, Error> =
  | { readonly status: "pending" }
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly error: Error }

// promiseSchema describes settlement events for promises sharing success and error types.
export function promiseSchema<Value, Error = never>(options: { readonly success: Schema.Schema<Value>; readonly error?: Schema.Schema<Error> }) {
  return Schema.Struct({ type: Schema.Literal("PromiseSettled"), ref: EffectRef, result: Schema.Union([
    Schema.Struct({ status: Schema.Literal("fulfilled"), value: options.success }),
    Schema.Struct({ status: Schema.Literal("rejected"), error: options.error ?? Schema.Never }),
  ]) })
}

// durablePromise declares a journal-scoped result; its settlement helpers produce events without executing or appending them.
export function durablePromise<Value, Error = never>(reference: EffectRef, options: {
  readonly success: Schema.Schema<Value>
  readonly error?: Schema.Schema<Error>
}) {
  const ref = Object.freeze(Schema.decodeSync(EffectRef, { onExcessProperty: "error" })(structuredClone(reference)))
  const id = effectKey(ref)
  const schema = promiseSchema(options)
  const result = schema.fields.result
  const validate = Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" })
  const stateSchema: Schema.Schema<PromiseState<Value, Error>> = Schema.Union([Schema.Struct({ status: Schema.Literal("pending") }), result])
  const state = durableAtom({
    schema: stateSchema,
    initial: { status: "pending" },
    reduce: (previous, event: unknown) => {
      if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "PromiseSettled") return previous
      const eventRef = Schema.decodeUnknownSync(EffectRef)("ref" in event ? event.ref : undefined)
      if (effectKey(eventRef) !== id) return previous
      const settlement = validate(event)
      if (previous.status === "pending") return settlement.result
      if (!isDeepStrictEqual(previous, settlement.result)) throw new RuntimeError(`Conflicting promise settlement: ${id}`)
      return previous
    },
  }).pipe(Atom.withLabel(`promise ${ref.atom}/${ref.tag}@${ref.seq}`))
  return {
    ref,
    id,
    schema,
    state,
    succeed: (value: Value) => validate({ type: "PromiseSettled", ref, result: { status: "fulfilled", value } }),
    fail: (error: Error) => validate({ type: "PromiseSettled", ref, result: { status: "rejected", error } }),
  }
}
