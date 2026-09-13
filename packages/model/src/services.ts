import { Layer, type SchemaRepresentation } from "effect"
import type { ModelPricing } from "@clavia/tardigrade-model/pricing"
import type { InferenceObserver } from "@clavia/tardigrade-model/stream/observer"
import { BindingSettings, type CostReader } from "@clavia/tardigrade-model/settings"
import { requestPolicyOf, type RequestOptions } from "./stream/request"
import { providerLayer, type ProviderOptions, type ProviderLayer } from "./providers/layer"
import type { OutputCapability } from "./output"
import type { ReportedCostReader } from "./usage"
import { reportedCostOf } from "./providers/usage"

// inferenceLayer supplies the native Effect model and the settings used by the agent binding.
export const inferenceLayer = (options: ProviderOptions & { readonly schemaImport?: SchemaRepresentation.FromJsonSchemaOptions; readonly providerId?: string; readonly observer?: InferenceObserver; readonly endpoint: string; readonly output?: OutputCapability; readonly pricing?: ModelPricing; readonly reportedCostUsd?: ReportedCostReader; readonly cost?: CostReader } & RequestOptions, layer: ProviderLayer = providerLayer) => {
  const ceiling = options.maxOutputTokens ?? (options.provider === "bedrock" ? options.model.config?.inferenceConfig?.maxTokens : options.provider === "anthropic" ? options.model.config?.max_tokens : options.provider === "openrouter" ? (options.model.config?.max_completion_tokens ?? options.model.config?.max_tokens) : options.model.config?.max_output_tokens)
  const policy = requestPolicyOf({ ...options, ...(ceiling == null ? {} : { maxOutputTokens: ceiling }) })
  const strict = options.output?.guarantee === "native"
  const configured: ProviderOptions = options.provider === "bedrock"
    ? { ...options, model: { ...options.model, config: { ...options.model.config, inferenceConfig: { ...options.model.config?.inferenceConfig, maxTokens: policy.maxOutputTokens } } } }
    : options.provider === "anthropic"
    ? { ...options, model: { ...options.model, config: { ...options.model.config, max_tokens: policy.maxOutputTokens, ...(strict ? { structuredOutputs: true, strictJsonSchema: true } : {}) } } }
    : options.provider === "openrouter"
    ? { ...options, model: { ...options.model, config: { ...options.model.config, max_tokens: policy.maxOutputTokens, max_completion_tokens: policy.maxOutputTokens, ...(strict ? { strictJsonSchema: true } : {}) } } }
    : options.provider === "openai-compat"
    ? { ...options, model: { ...options.model, config: { ...options.model.config, max_output_tokens: policy.maxOutputTokens, ...(strict ? { strictJsonSchema: true } : {}) } } }
    : { ...options, model: { ...options.model, config: { ...options.model.config, max_output_tokens: policy.maxOutputTokens, ...(strict ? { strictJsonSchema: true } : {}) } } }
  return Layer.merge(Layer.succeed(BindingSettings, {
    provider: options.providerId ?? options.provider,
    protocol: options.provider === "bedrock" ? "bedrock-converse" : options.provider === "openai" ? "openai-responses" : (options.provider === "openai-compat" || options.provider === "openrouter") ? "openai-chat-completions" : "anthropic",
    model: options.model.model,
    endpoint: options.endpoint,
    policy,
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.schemaImport === undefined ? {} : { schemaImport: options.schemaImport }),
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    reportedCostUsd: options.reportedCostUsd ?? reportedCostOf
  }), layer({ ...configured, unvalidatedConfig: options.model.config }))
}
