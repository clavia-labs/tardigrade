import type { InferenceProvider } from "../infer"
import { environment, environmentNumber } from "./environment"
import { openAiChatInference } from "./openai-chat"

export interface CloudflareGatewayInferenceOptions {
  readonly accountId?: string
  readonly apiToken?: string
  readonly gatewayId?: string
  readonly model?: string
  readonly contextWindow?: number
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

export const cloudflareGatewayInference = (
  options: CloudflareGatewayInferenceOptions = {}
): InferenceProvider => {
  const configuredAccount = options.accountId ?? environment("CLOUDFLARE_ACCOUNT_ID")
  const configuredToken = options.apiToken ?? environment("CLOUDFLARE_API_TOKEN")
  const accountId = configuredAccount === "" ? undefined : configuredAccount
  const apiToken = configuredToken === "" ? undefined : configuredToken
  const gatewayId = options.gatewayId ?? environment("CLOUDFLARE_AI_GATEWAY_ID")
  const model =
    options.model ?? environment("CLOUDFLARE_AI_MODEL") ?? "anthropic/claude-sonnet-4"
  const contextWindow =
    options.contextWindow ?? environmentNumber("CLOUDFLARE_AI_CONTEXT_WINDOW") ?? 200_000
  const baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4/accounts"
  const missing = [
    ...(accountId === undefined ? ["CLOUDFLARE_ACCOUNT_ID or accountId"] : []),
    ...(apiToken === undefined ? ["CLOUDFLARE_API_TOKEN or apiToken"] : [])
  ]
  return openAiChatInference({
    id: `cloudflare-ai-gateway:${model}`,
    provider: "cloudflare-ai-gateway",
    model,
    contextWindow,
    endpoint: `${baseUrl.replace(/\/$/, "")}/${accountId ?? "missing"}/ai/v1/chat/completions`,
    ...(apiToken === undefined ? {} : { apiKey: apiToken }),
    ...(gatewayId === undefined ? {} : { headers: { "cf-aig-gateway-id": gatewayId } }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(missing.length === 0
      ? {}
      : { configurationError: `Cloudflare AI Gateway needs ${missing.join(" and ")}` })
  })
}
