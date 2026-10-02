import { MethodInvocation } from "./method"
import { Schema } from "effect"
import { EffectRef, RuntimeError } from "../runtime/effects"
import { ThreadCoordinate } from "./thread"

export const TransportAddress = Schema.Struct({ transport: Schema.NonEmptyString, address: Schema.Json })
export type TransportAddress = typeof TransportAddress.Type
export const MessageAddress = Schema.Union([ThreadCoordinate, TransportAddress])
export type MessageAddress = typeof MessageAddress.Type

export const MessageSender = Schema.Union([MessageAddress, Schema.Struct({ kind: Schema.Literal("external"), id: Schema.NonEmptyString })])
export type MessageSender = typeof MessageSender.Type

export const MessageMetadata = Schema.Struct({
  id: Schema.NonEmptyString,
  from: MessageSender,
  invocation: Schema.optionalKey(MethodInvocation),
  inReplyTo: Schema.optionalKey(Schema.NonEmptyString),
})
export type MessageMetadata = typeof MessageMetadata.Type

// MessageReceived records an actor input whose delivery context belongs to the journal envelope.
export const MessageReceived = Schema.Struct({ type: Schema.Literal("MessageReceived"), body: Schema.Json })
export type MessageReceived = typeof MessageReceived.Type

// isMessageReceived distinguishes framework inbox records from actor-defined input payloads.
export const isMessageReceived = (event: unknown): event is MessageReceived =>
  typeof event === "object" && event !== null && "type" in event && event.type === "MessageReceived" && "body" in event

export const MessageReceipt = Schema.Struct({
  id: Schema.NonEmptyString,
  position: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))),
})
export type MessageReceipt = typeof MessageReceipt.Type

// MessageDelivered discharges a reply obligation after the recipient acknowledges acceptance.
export const MessageDelivered = Schema.Struct({ type: Schema.Literal("MessageDelivered"), id: Schema.NonEmptyString, ref: EffectRef, receipt: MessageReceipt })
export type MessageDelivered = typeof MessageDelivered.Type

export class MessageConflict extends Error { readonly _tag = "MessageConflict" }

// InvalidMessage rejects input that violates the receiving actor's contract before journal admission.
export class InvalidMessage extends RuntimeError {
  static override from(cause: unknown): InvalidMessage {
    return cause instanceof InvalidMessage ? cause : new InvalidMessage(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}
