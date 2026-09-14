import { Schema } from "effect"

// ModelPricing states the rates used for an independent cost projection.
export const ModelPricing = Schema.Struct({
  promptUsdPerToken: Schema.Finite,
  completionUsdPerToken: Schema.Finite,
  cachedPromptUsdPerToken: Schema.optionalKey(Schema.Finite),
  cacheWritePromptUsdPerToken: Schema.optionalKey(Schema.Finite)
})
export type ModelPricing = typeof ModelPricing.Type
