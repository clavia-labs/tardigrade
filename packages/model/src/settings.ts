import { Context, Effect, Schema, type SchemaRepresentation } from "effect"
import type { Response } from "effect/unstable/ai"
import type { ModelRef } from "./reference"
import type { ModelResolution } from "./reference"
import type { ModelPricing } from "./pricing"
import type { InferenceObserver } from "./stream/observer"
import type { OutputCapability } from "./output"
import { requestPolicyOf } from "./stream/request"
import type { RequestPolicy } from "./stream/policy"

const NonNegativeCost = Schema.Finite.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, {
    title: "at or above zero",
    toJsonSchema: () => ({ minimum: 0 })
  }))
)

// CostEvidence records the effective cost of a logical attempt and preserves independent provider and table evidence.
export const CostEvidence = Schema.Struct({
  costUsd: Schema.optionalKey(NonNegativeCost),
  costSource: Schema.optionalKey(Schema.Literals(["provider", "table"])),
  reportedCostUsd: Schema.optionalKey(NonNegativeCost),
  estimatedCostUsd: Schema.optionalKey(NonNegativeCost)
})
export type CostEvidence = typeof CostEvidence.Type
// CostReader extracts normalized cost evidence from a provider finish part.
export type CostReader = (part: Response.FinishPart) => CostEvidence | undefined

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
  readonly cost?: CostReader
}

export const BindingSettings = Context.Reference<BindingOptions>("tardie/BindingSettings", {
  defaultValue: () => ({ provider: "custom", protocol: "effect", model: "custom", endpoint: "", policy: requestPolicyOf({}) })
})
export const CurrentModel = Context.Reference<ModelRef | undefined>("tardie/CurrentModel", { defaultValue: () => undefined })
export const ProviderRequestKey = Context.Reference<string | undefined>("tardie/model/ProviderRequestKey", { defaultValue: () => undefined })
// ModelSelection supplies catalog authority and settings independently of inference.
export const ModelSelection = Context.Reference<{
  readonly resolve?: (model?: ModelRef) => ModelResolution
  readonly settings?: (model?: ModelRef) => Effect.Effect<BindingOptions>
}>("tardie/ModelSelection", { defaultValue: () => ({}) })
