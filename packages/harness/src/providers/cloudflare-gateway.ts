import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { Duration } from "effect"
import type { ProviderOptions } from "@ai-sdk/provider-utils"
import type { Effort, InferenceProvider, ModelPricing } from "../infer"
import { environment, environmentNumber } from "./environment"
import { modelInference } from "./model"

export interface CloudflareGatewayInferenceOptions {
  readonly accountId?: string
  readonly apiToken?: string
  readonly gatewayId?: string
  readonly model?: string
  // What the model accepts. This endpoint publishes no catalog on the path its chat requests use, so
  // the caller is the only one who can say, and `CLOUDFLARE_AI_CONTEXT_WINDOW` says it for a
  // deployment that would rather configure it than write it.
  readonly contextWindow?: number
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  // The transport settings, forwarded rather than fixed here.
  readonly headers?: Readonly<Record<string, string>>
  readonly retries?: number
  readonly timeout?: Duration.Input
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly reasoning?: Effort
  readonly pricing?: ModelPricing
  readonly providerOptions?: ProviderOptions
}

// This endpoint speaks the OpenAI-compatible format rather than the gateway's own, so it is built on
// the SDK's provider for that format. The adapter above it is the same one every model uses.
export const cloudflareGatewayInference = (
  options: CloudflareGatewayInferenceOptions = {}
): InferenceProvider => {
  const configuredAccount = options.accountId ?? environment("CLOUDFLARE_ACCOUNT_ID")
  const accountId = configuredAccount === "" ? undefined : configuredAccount
  const configuredToken = options.apiToken ?? environment("CLOUDFLARE_API_TOKEN")
  const apiToken = configuredToken === "" ? undefined : configuredToken
  const gatewayId = options.gatewayId ?? environment("CLOUDFLARE_AI_GATEWAY_ID")
  const model = options.model ?? environment("CLOUDFLARE_AI_MODEL") ?? "anthropic/claude-sonnet-4"
  // No catalog on this path, so nobody but the caller can say what the model accepts. An invented
  // figure would decide when compaction fires for every Cloudflare model at once, so its absence is
  // a construction error rather than a number this file chose.
  const contextWindow = options.contextWindow ?? environmentNumber("CLOUDFLARE_AI_CONTEXT_WINDOW")
  if (contextWindow === undefined) {
    throw new Error(
      "Cloudflare AI Gateway needs contextWindow or CLOUDFLARE_AI_CONTEXT_WINDOW: this endpoint " +
        `publishes no catalog, so nothing here can say what ${model} accepts.`
    )
  }
  const baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4/accounts"
  const provider = createOpenAICompatible({
    name: "cloudflare-ai-gateway",
    baseURL: `${baseUrl.replace(/\/$/, "")}/${accountId ?? "missing"}/ai/v1`,
    ...(apiToken === undefined ? {} : { apiKey: apiToken }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    headers: {
      ...(gatewayId === undefined ? {} : { "cf-aig-gateway-id": gatewayId }),
      ...options.headers
    }
  })
  return modelInference({
    id: `cloudflare-ai-gateway:${model}`,
    provider: "cloudflare-ai-gateway",
    model,
    contextWindow,
    languageModel: provider(model),
    // The account names the endpoint, so its absence is known here rather than at the request.
    ...(accountId === undefined
      ? { configurationError: "Cloudflare AI Gateway needs CLOUDFLARE_ACCOUNT_ID or accountId" }
      : {}),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions })
  })
}
