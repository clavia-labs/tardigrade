import { Schema } from "effect"
import { EffectRef } from "./effect-ref"
import { EffectCancelled } from "./cancellation"
import { promiseSchema } from "./promise"

export const EffectRequest = Schema.Struct({ executor: Schema.NonEmptyString, input: Schema.Json })
export type EffectRequest = typeof EffectRequest.Type

// EffectRequested records a request durably accepted for execution.
export const EffectRequested = Schema.Struct({
  type: Schema.Literal("EffectRequested"),
  ref: EffectRef,
  request: EffectRequest,
})
export type EffectRequested = typeof EffectRequested.Type

export { EffectCancelled, Cancelled } from "./cancellation"

// PromiseSettled records the eventual outcome of a durable promise.
export const PromiseSettled = promiseSchema({ success: Schema.Json, error: Schema.Json })
export type PromiseSettled = typeof PromiseSettled.Type

// EffectSettled records an execution attempt's success or failure.
export const EffectSettled = Schema.Struct({
  type: Schema.Literal("EffectSettled"),
  ref: EffectRef,
  outcome: PromiseSettled.fields.result,
})
export type EffectSettled = typeof EffectSettled.Type

export const CoreEvent = Schema.Union([EffectRequested, EffectSettled, PromiseSettled, EffectCancelled])
export type CoreEvent = typeof CoreEvent.Type

// hasCoreEventType identifies event names reserved for core lifecycle records.
export function hasCoreEventType(event: object): boolean {
  return "type" in event && (event.type === "EffectRequested" || event.type === "EffectSettled" || event.type === "PromiseSettled" || event.type === "EffectCancelled")
}
