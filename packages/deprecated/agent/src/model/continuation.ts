import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"

// ProviderContinuation preserves encoded prompt evidence for compatible replay (binding/continuation.test.ts).
export const ProviderContinuation = Schema.Struct({
  protocol: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  endpoint: Schema.String,
  payload: Schema.toEncoded(Prompt.Prompt)
})
export type ProviderContinuation = typeof ProviderContinuation.Type
