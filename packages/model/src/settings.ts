import { Context, Effect, type SchemaRepresentation } from "effect"
import type { Response } from "effect/unstable/ai"
import type { ModelRef } from "./reference"
import type { ModelPricing } from "./pricing"
import type { InferenceObserver } from "./stream/observer"
import type { OutputCapability } from "./output"
import { requestPolicyOf } from "./stream/request"
import type { RequestPolicy } from "./stream/policy"

export interface BindingOptions {
  readonly provider: string
  readonly protocol: string
  readonly model: string
  readonly endpoint: string
  readonly policy: RequestPolicy
  readonly output?: OutputCapability
  readonly pricing?: ModelPricing
  readonly observer?: InferenceObserver
  readonly schemaImport?: SchemaRepresentation.FromJsonSchemaOptions
  readonly reportedCostUsd?: (part: Response.FinishPart) => number | undefined
}

export const BindingSettings = Context.Reference<BindingOptions>("tardie/BindingSettings", {
  defaultValue: () => ({ provider: "custom", protocol: "effect", model: "custom", endpoint: "", policy: requestPolicyOf({}) })
})
export const CurrentModel = Context.Reference<ModelRef | undefined>("tardie/CurrentModel", { defaultValue: () => undefined })
export const ProviderRequestKey = Context.Reference<string | undefined>("tardie/model/ProviderRequestKey", { defaultValue: () => undefined })
// ModelSelection supplies execution settings for the selected model.
export const ModelSelection = Context.Reference<{
  readonly settings?: (model?: ModelRef) => Effect.Effect<BindingOptions>
}>("tardie/ModelSelection", { defaultValue: () => ({}) })

// modelSettingsFor loads selected provider settings or the supplied custom settings (agent/integration/compact.test.ts, agent/integration/model-host.test.ts).
export const modelSettingsFor = (model?: ModelRef) => Effect.flatMap(ModelSelection, selection => selection.settings?.(model) ?? BindingSettings)
