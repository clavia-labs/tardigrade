import { Schema } from "effect"
import { EffectRef } from "./effect-ref"

// AbortReceived records an actor stop signal; the actor defines its operation boundary and settlement.
export const AbortReceived = Schema.Struct({ type: Schema.Literal("AbortReceived"), reason: Schema.String })
export type AbortReceived = typeof AbortReceived.Type

// EffectCancelled records a terminal local cancellation decision; executor cleanup may still be pending.
export const EffectCancelled = Schema.Struct({ type: Schema.Literal("EffectCancelled"), ref: EffectRef, reason: Schema.Json })
export type EffectCancelled = typeof EffectCancelled.Type

export const Cancelled = Schema.TaggedStruct("Cancelled", { reason: Schema.Json })
export type Cancelled = typeof Cancelled.Type

