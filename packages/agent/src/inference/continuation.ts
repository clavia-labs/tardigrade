import { Schema } from "effect"

// ProviderContinuation preserves one native assistant response for compatible replay (packages/model/src/inference/response.test.ts).
export const ProviderContinuation = Schema.Struct({
  format: Schema.optional(Schema.String),
  protocol: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  endpoint: Schema.String,
  payload: Schema.Array(Schema.Unknown)
})
export type ProviderContinuation = typeof ProviderContinuation.Type
