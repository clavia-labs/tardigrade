import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import { Atom } from "effect/reactivity"
import { durableAtom } from "./durable"
import { EffectRef, effectKey, RuntimeError, Cancelled, EffectCancelled, PromiseTimedOut } from "../runtime/effects"

export type PromiseState<Value, Error> =
  | { readonly status: "pending" }
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly reason: Error | PromiseTimedOut }

// promiseSchema describes settlement events for promises sharing success and error types.
export function promiseSchema<Value, Error = never>(options: { readonly success: Schema.Schema<Value>; readonly error?: Schema.Schema<Error> }) {
  return Schema.Struct({ type: Schema.Literal("PromiseSettled"), ref: EffectRef, result: Schema.Union([
    Schema.Struct({ status: Schema.Literal("fulfilled"), value: options.success }),
    Schema.Struct({ status: Schema.Literal("rejected"), reason: Schema.Union([options.error ?? Schema.Never, PromiseTimedOut]) }),
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
  const stateSchema: Schema.Schema<PromiseState<Value, Error | Cancelled | PromiseTimedOut>> = Schema.Union([Schema.Struct({ status: Schema.Literal("pending") }), result, Schema.Struct({ status: Schema.Literal("rejected"), reason: Cancelled })])
  const state = durableAtom({
    name: `promise:${id}`,
    input: Schema.Union([Schema.Struct({ type: Schema.Literal("PromiseSettled"), ref: EffectRef, result: Schema.Unknown }), EffectCancelled]),
    schema: stateSchema,
    initial: { status: "pending" },
    reduce: (previous, event) => {
      if (effectKey(event.ref) !== id) return previous
      if (event.type === "EffectCancelled") return previous.status === "pending" ? { status: "rejected" as const, reason: { _tag: "Cancelled" as const, reason: event.reason } } : previous
      if (previous.status === "rejected" && Schema.is(Cancelled)(previous.reason)) return previous
      const settlement = validate(event)
      if (previous.status === "pending") return settlement.result
      if (!isDeepStrictEqual(previous, settlement.result)) throw new RuntimeError(`Conflicting promise settlement: ${id}`)
      return previous
    },
  }).pipe(Atom.withLabel(`promise ${ref.atom}/${ref.act}@${ref.seq}`))
  return {
    ref,
    id,
    schema,
    state,
    succeed: (value: Value) => validate({ type: "PromiseSettled", ref, result: { status: "fulfilled", value } }),
    fail: (reason: Error) => validate({ type: "PromiseSettled", ref, result: { status: "rejected", reason } }),
  }
}
