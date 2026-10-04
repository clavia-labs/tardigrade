import { Schema } from "effect"
import { EffectRef } from "./effects"
import { InputDigest } from "./input-digest"

export const InlineInput = Schema.TaggedStruct("InlineInput", { value: Schema.Json })

// StoredEffectRequest distinguishes executable JSON from a validation digest (quint/effectInput.qnt, Stored).
export const StoredEffectRequest = Schema.Struct({
  act: Schema.NonEmptyString,
  input: Schema.Union([InlineInput, InputDigest]),
})
export type StoredEffectRequest = typeof StoredEffectRequest.Type

export const StoredEffectRequested = Schema.Struct({
  type: Schema.Literal("EffectRequested"),
  ref: EffectRef,
  request: StoredEffectRequest,
})
export type StoredEffectRequested = typeof StoredEffectRequested.Type

// EffectAcceptance exposes identity and act independently of input (quint/checkpoint/inputLifecycle.qnt, observationIndependent).
export const EffectAcceptance = Schema.Struct({
  type: Schema.Literal("EffectRequested"),
  ref: EffectRef,
  act: Schema.NonEmptyString,
})
export type EffectAcceptance = typeof EffectAcceptance.Type
