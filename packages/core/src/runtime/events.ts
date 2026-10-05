import { Schema } from "effect"
import { EffectRef, EffectCancelled } from "./effects"
import { EffectAcceptance, StoredEffectRequested } from "./effect-request"
import { promiseSchema } from "../atoms/promise"
import { MessageReceived, MessageDelivered, isMessageReceived } from "../actor/message"
import { ThreadCreated } from "../actor/thread"
import { StateInitialised } from "../initialise"
export { StateInitialised } from "../initialise"
export { InlineInput, StoredEffectRequest, StoredEffectRequested, EffectAcceptance } from "./effect-request"

export const EffectRequest = Schema.Struct({ act: Schema.NonEmptyString, input: Schema.Json })
export type EffectRequest = typeof EffectRequest.Type

// EffectRequested records a request durably accepted for execution.
export const EffectRequested = StoredEffectRequested
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

// RetryScheduled preserves the next attempt's absolute wake while the operation remains pending.
export const RetryScheduled = Schema.Struct({
  type: Schema.Literal("RetryScheduled"),
  ref: EffectRef,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  dueAt: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  reason: Schema.Json,
})
export type RetryScheduled = typeof RetryScheduled.Type

const lifecycleEvents = [EffectSettled, PromiseSettled, RetryScheduled, EffectCancelled, ThreadCreated, MessageDelivered, MessageReceived, StateInitialised] as const
export const CoreEvent = Schema.Union([EffectRequested, ...lifecycleEvents])
export type CoreEvent = typeof CoreEvent.Type
export const ObservedCoreEvent = Schema.Union([EffectAcceptance, ...lifecycleEvents])
export type ObservedCoreEvent = typeof ObservedCoreEvent.Type

// hasCoreEventType identifies event names reserved for framework records.
export function hasCoreEventType(event: object): boolean {
  return isMessageReceived(event) || "type" in event && (event.type === "EffectRequested" || event.type === "EffectSettled" || event.type === "PromiseSettled" || event.type === "RetryScheduled" || event.type === "EffectCancelled" || event.type === "ThreadCreated" || event.type === "MessageDelivered" || event.type === "StateInitialised")
}
