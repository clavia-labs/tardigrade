import { Layer, type SchemaRepresentation } from "effect"
import type { ModelPricing } from "@clavia/tardigrade-agent/inference/usage"
import type { InferenceObserver } from "@clavia/tardigrade-agent/inference/observer"
import { BindingSettings } from "@clavia/tardigrade-agent/binding/settings"
import { requestPolicyOf, type RequestOptions } from "../inference/request"
import { providerLayer, type ProviderOptions } from "../providers/layer"
import type { OutputCapability } from "./output"
import type { ReportedCostReader } from "./usage"

// inferenceLayer supplies the native Effect model and the settings used by the agent binding.
export const inferenceLayer = (options: ProviderOptions & { readonly schemaImport?: SchemaRepresentation.FromJsonSchemaOptions; readonly providerId?: string; readonly observer?: InferenceObserver; readonly endpoint: string; readonly output?: OutputCapability; readonly pricing?: ModelPricing; readonly reportedCostUsd?: ReportedCostReader } & RequestOptions) => {
  const ceiling = options.maxOutputTokens ?? (options.provider === "bedrock" ? options.model.config?.inferenceConfig?.maxTokens : options.provider === "anthropic" ? options.model.config?.max_tokens : options.model.config?.max_output_tokens)
  const policy = requestPolicyOf({ ...options, ...(ceiling == null ? {} : { maxOutputTokens: ceiling }) })
  const strict = options.output?.guarantee === "native"
  const configured: ProviderOptions = options.provider === "bedrock"
    ? { ...options, model: { ...options.model, config: { ...options.model.config, inferenceConfig: { ...options.model.config?.inferenceConfig, maxTokens: policy.maxOutputTokens } } } }
    : options.provider === "anthropic"
    ? { ...options, model: { ...options.model, config: { ...options.model.config, max_tokens: policy.maxOutputTokens, ...(strict ? { structuredOutputs: true, strictJsonSchema: true } : {}) } } }
    : options.provider === "openai-compat"
    ? { ...options, model: { ...options.model, config: { ...options.model.config, max_output_tokens: policy.maxOutputTokens, ...(strict ? { strictJsonSchema: true } : {}) } } }
    : { ...options, model: { ...options.model, config: { ...options.model.config, max_output_tokens: policy.maxOutputTokens, ...(strict ? { strictJsonSchema: true } : {}) } } }
  return Layer.merge(Layer.succeed(BindingSettings, {
    provider: options.providerId ?? options.provider,
    protocol: options.provider === "bedrock" ? "bedrock-converse" : options.provider === "openai" ? "openai-responses" : options.provider === "openai-compat" ? "openai-chat-completions" : "anthropic",
    model: options.model.model,
    endpoint: options.endpoint,
    policy,
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.schemaImport === undefined ? {} : { schemaImport: options.schemaImport }),
    ...(options.reportedCostUsd === undefined ? {} : { reportedCostUsd: options.reportedCostUsd })
  }), providerLayer(configured))
}
