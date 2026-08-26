import { Schema } from "effect"

// ModelRef identifies the provider and model an actor requests. The host supplies the provider connection.
export const ModelRef = Schema.Struct({
  provider: Schema.NonEmptyString,
  model_id: Schema.NonEmptyString
})

export type ModelRef = typeof ModelRef.Type

// modelRefOf reads a complete model reference from an untyped message or tool argument.
export const modelRefOf = (value: unknown): ModelRef | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const reference = value as { readonly provider?: unknown; readonly model_id?: unknown }
  if (typeof reference.provider !== "string" || reference.provider.trim().length === 0) return undefined
  if (typeof reference.model_id !== "string" || reference.model_id.trim().length === 0) return undefined
  return { provider: reference.provider.trim(), model_id: reference.model_id.trim() }
}
