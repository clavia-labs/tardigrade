import { Schema } from "effect"
import type { KeyFragment } from "../log/index"

// ExternalReplyReceived records that a durable external receipt is available for an awaited effect.
export const ExternalReplyReceived = Schema.Struct({
  type: Schema.Literal("ExternalReplyReceived"),
  id: Schema.NonEmptyString,
  at: Schema.Finite
})

export type ExternalReplyReceived = typeof ExternalReplyReceived.Type

// externalReplyKeys derives readiness identity from the awaited id.
export const externalReplyKeys: KeyFragment = {
  prefixes: ["external-reply:"],
  keyOf: (event) => {
    if (event.type !== "ExternalReplyReceived") return undefined
    const value = event as { readonly id?: unknown; readonly at?: unknown }
    return typeof value.id === "string" && value.id.length > 0 && typeof value.at === "number" && Number.isFinite(value.at)
      ? `external-reply:${value.id}`
      : undefined
  }
}

// externalReplyReceived constructs a validated external readiness notification.
export const externalReplyReceived = (fields: {
  readonly id: string
  readonly at: number
}): ExternalReplyReceived => Schema.decodeSync(ExternalReplyReceived)({ type: "ExternalReplyReceived", ...fields })
