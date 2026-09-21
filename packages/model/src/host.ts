import { failedProviderLayer, type ProviderLayer } from "./providers/layer"
import { protocolOptionsOf } from "./providers/options"
import { MODEL_PROTOCOLS, modelProviderModuleOf } from "./providers/directory"
import type { ModelConfig as BedrockModelConfig } from "@tardie/ai-bedrock/BedrockLanguageModel"
import { requestPolicyOf } from "./stream/request"
import { Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { type InferenceObserver } from "./stream/observer"
import type { OpenRouterLanguageModel } from "@tardie/ai-openrouter"
import type { OpenAiLanguageModel } from "@tardie/ai-openai"
import type { OpenAiLanguageModel as CompatLanguageModel } from "@tardie/ai-openai-compat"
import type { AnthropicLanguageModel } from "@tardie/ai-anthropic"
import { modelLayerWith, type ModelHostConfig, type SelectedModel } from "./selection"
import type { ModelCatalogState } from "./catalog/index"
import type { ReportedCostReader } from "./usage"
import type { OutputCapability } from "./output"
import type { RequestOptions } from "./stream/request"
import { inferenceLayer } from "./services"

export interface ModelSettings extends RequestOptions {
  readonly openrouter?: Parameters<typeof OpenRouterLanguageModel.layer>[0]["config"]
  readonly reportedCostUsd?: ReportedCostReader
  readonly openai?: Parameters<typeof OpenAiLanguageModel.layer>[0]["config"]
  readonly bedrock?: BedrockModelConfig
  readonly compat?: Parameters<typeof CompatLanguageModel.layer>[0]["config"]
  readonly anthropic?: Parameters<typeof AnthropicLanguageModel.layer>[0]["config"]
  readonly output?: OutputCapability
}

export interface ModelIntegrationOptions {
  readonly providerLayer?: ProviderLayer
  readonly configure?: (selected: SelectedModel) => ModelSettings
}

export interface ModelHostOptions extends ModelIntegrationOptions {
  readonly observer?: InferenceObserver
}

// modelLayer binds configured models through Effect while sharing host authority and catalog selection (host.test.ts).
export const modelLayer = (config: ModelHostConfig, catalog: ModelCatalogState, options: ModelHostOptions = {}) => modelLayerWith(config, catalog, (selected) => {
  try {
    const configured = protocolOptionsOf(selected.protocol, config.model.providers[selected.provider]?.models?.[selected.model_id]?.options)
    const overrides = options.configure?.(selected) ?? {}
    const openrouter = modelProviderModuleOf(selected.provider, selected.protocol) === "openrouter"
    const settings: ModelSettings = {
      ...overrides,
      ...(configured.options === undefined ? {} : configured.protocol === "openai-responses" ? { openai: { ...configured.options, ...overrides.openai } }
        : configured.protocol === "openai-chat-completions" && openrouter ? { openrouter: { ...configured.options, ...overrides.openrouter } }
        : configured.protocol === "openai-chat-completions" ? { compat: { ...configured.options, ...overrides.compat } }
        : configured.protocol === "anthropic-messages" ? { anthropic: { ...configured.options, ...overrides.anthropic } }
        : { bedrock: { ...configured.options, ...overrides.bedrock } })
    }
    const nativeLimit = openrouter ? (settings.openrouter?.max_completion_tokens ?? settings.openrouter?.max_tokens) : selected.protocol === "bedrock-converse" ? settings.bedrock?.inferenceConfig?.maxTokens : selected.protocol === "openai-responses" ? settings.openai?.max_output_tokens : selected.protocol === "openai-chat-completions" ? settings.compat?.max_output_tokens : settings.anthropic?.max_tokens
    const limits = [selected.maxOutputTokens, settings.maxOutputTokens, nativeLimit].filter((value): value is number => value != null)
    const common = {
      ...settings,
      providerId: selected.provider,
      endpoint: selected.baseUrl,
      client: { apiKey: Redacted.make(selected.apiKey), apiUrl: selected.baseUrl },
      ...(limits.length === 0 ? {} : { maxOutputTokens: Math.min(...limits) }),
      ...(selected.pricing === undefined ? {} : { pricing: selected.pricing }),
      ...(options.observer === undefined ? {} : { observer: options.observer })
    }
    if (selected.protocol === "bedrock-converse") {
      const region = selected.region ?? new URL(selected.baseUrl).pathname.split("/").filter(Boolean).at(-1)
      if (region === undefined) throw new Error("a Bedrock connection must declare its AWS region")
      const policy = requestPolicyOf(common)
      return inferenceLayer({ ...common, provider: "bedrock", gateway: { apiKey: selected.apiKey, bounds: policy.timeout }, model: { model: selected.model_id, ...(settings.bedrock === undefined ? {} : { config: settings.bedrock }) }, client: {
        region, endpoint: selected.baseUrl, token: { token: "byok" }, authSchemePreference: ["httpBearerAuth"]
      } }, options.providerLayer).pipe(Layer.provide(FetchHttpClient.layer))
    }
    return inferenceLayer(
      selected.protocol === "openai-responses"
      ? { ...common, provider: "openai", model: { model: selected.model_id, ...(settings.openai === undefined ? {} : { config: settings.openai }) } }
      : openrouter
      ? { ...common, provider: "openrouter", model: { model: selected.model_id, ...(settings.openrouter === undefined ? {} : { config: settings.openrouter }) } }
      : selected.protocol === "openai-chat-completions"
      ? { ...common, provider: "openai-compat", model: { model: selected.model_id, ...(settings.compat === undefined ? {} : { config: settings.compat }) } }
      : { ...common, provider: "anthropic", model: { model: selected.model_id, ...(settings.anthropic === undefined ? {} : { config: settings.anthropic }) } }
      , options.providerLayer
    ).pipe(Layer.provide(FetchHttpClient.layer))
  } catch (error) {
    return failedProviderLayer(error)
  }
}, MODEL_PROTOCOLS)

export { MISSING_MODEL, modelIsConfigured, selectedModelFrom, modelLayerWith, type ModelHostConfig, type SelectedModel } from "./selection"
