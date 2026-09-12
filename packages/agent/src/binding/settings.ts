import { Context, Effect, type SchemaRepresentation } from "effect"
import type { Response } from "effect/unstable/ai"
import type { ModelRef } from "../inference/reference"
import type { ModelResolution, InferRequest } from "../inference/contract"
import type { InferDelta } from "../inference/observer"
import type { ModelPricing } from "../inference/usage"
import type { InferenceObserver } from "../inference/observer"
import type { OutputCapability } from "./output"
import { requestPolicyOf } from "./request"
import type { RequestPolicy } from "../inference/retry"

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
export const BindingInvocation = Context.Reference<{
  readonly request: InferRequest
  readonly key?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly onDelta?: ((delta: InferDelta) => void) | undefined
} | undefined>("tardie/BindingInvocation", { defaultValue: () => undefined })

// ModelSelection supplies catalog authority and settings independently of inference.
export const ModelSelection = Context.Reference<{
  readonly resolve?: (model?: ModelRef) => ModelResolution
  readonly settings?: (model?: ModelRef) => Effect.Effect<BindingOptions>
}>("tardie/ModelSelection", { defaultValue: () => ({}) })
