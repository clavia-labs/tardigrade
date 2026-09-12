import { Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { providerLayer, type ProviderOptions } from "../../../../packages/model/src/providers/layer"
import { inferenceLayer } from "../../../../packages/model/src/binding/index"
import type { Send as BedrockSend } from "@tardie/ai-bedrock/BedrockLanguageModel"
import { DEFAULT_LIVE_MAX_OUTPUT_TOKENS, DEFAULT_LIVE_THINKING_TOKENS, DEFAULT_LIVE_TIMEOUT_MS, positive, type ResolvedLiveTarget } from "./config"

const optionsOf = (target: ResolvedLiveTarget): ProviderOptions => {
  const reasoning = target.behaviors.includes("reasoning")
  const maxTokens = positive("TARDIE_LIVE_MAX_OUTPUT_TOKENS", DEFAULT_LIVE_MAX_OUTPUT_TOKENS)
  const budget = positive("TARDIE_LIVE_THINKING_TOKENS", DEFAULT_LIVE_THINKING_TOKENS)
  const client = { apiKey: Redacted.make(target.apiKey), apiUrl: target.endpoint }
  switch (target.protocol) {
    case "openai-responses": return { provider: "openai", client, model: { model: target.model, config: { store: false, max_output_tokens: maxTokens, ...(reasoning ? { reasoning: { effort: "high" } } : {}) } } }
    case "openai-chat-completions": return { provider: "openai-compat", client, model: { model: target.model, config: { max_output_tokens: maxTokens, ...(reasoning ? { reasoning_effort: "high" } : {}) } } }
    case "anthropic-messages": return { provider: "anthropic", client, model: { model: target.model, config: { max_tokens: maxTokens, ...(reasoning ? { thinking: { type: "enabled", budget_tokens: budget } } : {}) } } }
    case "bedrock-converse": return { provider: "bedrock", client: { ...(target.region === undefined ? {} : { region: target.region }), endpoint: target.endpoint, token: { token: target.apiKey }, authSchemePreference: ["httpBearerAuth"] }, model: { model: target.model, config: { inferenceConfig: { maxTokens }, ...(reasoning ? { additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: budget } } } : {}) } } }
  }
}

export const providerFor = (target: ResolvedLiveTarget) => providerLayer(optionsOf(target)).pipe(Layer.provide(FetchHttpClient.layer))
export const bindingFor = (target: ResolvedLiveTarget, overrides: { readonly providerId?: string; readonly bedrockSend?: BedrockSend } = {}) => {
  const options = optionsOf(target)
  const configured: ProviderOptions = options.provider === "bedrock" && overrides.bedrockSend !== undefined ? { ...options, client: { send: overrides.bedrockSend } } : options
  return inferenceLayer({ ...configured, providerId: overrides.providerId ?? "live", endpoint: target.endpoint, maxOutputTokens: positive("TARDIE_LIVE_MAX_OUTPUT_TOKENS", DEFAULT_LIVE_MAX_OUTPUT_TOKENS), retry: { backoffMs: [] }, timeout: { attemptMs: positive("TARDIE_LIVE_TIMEOUT_MS", DEFAULT_LIVE_TIMEOUT_MS) } }).pipe(Layer.provide(FetchHttpClient.layer))
}
