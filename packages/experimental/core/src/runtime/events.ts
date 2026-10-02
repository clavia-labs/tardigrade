import { Schema } from "effect"
import { EffectRef, EffectCancelled } from "./effects"
import { promiseSchema } from "../atoms/promise"
import { MessageReceived, MessageDelivered, isMessageReceived } from "../actor/message"
import { ThreadCreated } from "../actor/thread"
import { StateInitialised } from "../initialise"
export { StateInitialised } from "../initialise"

export const EffectRequest = Schema.Struct({ executor: Schema.NonEmptyString, input: Schema.Json })
export type EffectRequest = typeof EffectRequest.Type

// EffectRequested records a request durably accepted for execution.
export const EffectRequested = Schema.Struct({
  type: Schema.Literal("EffectRequested"),
  ref: EffectRef,
  request: EffectRequest,
})
export type EffectRequested = typeof EffectRequested.Type

export { EffectCancelled, Cancelled } from "./effects"

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

export const CoreEvent = Schema.Union([EffectRequested, EffectSettled, PromiseSettled, EffectCancelled, ThreadCreated, MessageDelivered, MessageReceived, StateInitialised])
export type CoreEvent = typeof CoreEvent.Type

// hasCoreEventType identifies event names reserved for framework records.
export function hasCoreEventType(event: object): boolean {
  return isMessageReceived(event) || "type" in event && (event.type === "EffectRequested" || event.type === "EffectSettled" || event.type === "PromiseSettled" || event.type === "EffectCancelled" || event.type === "ThreadCreated" || event.type === "MessageDelivered" || event.type === "StateInitialised")
}
