import { Config, Redacted } from "effect"
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
  const accountId = configuredAccount === "" ? undefined : configuredAccount
  // The token is the secret, so it is read as a `Config` where the request is made. The account and
  // the gateway name are read here because the endpoint is built here.
  const configuredToken = options.apiToken === "" ? undefined : options.apiToken
  const apiToken =
    configuredToken === undefined
      ? Config.redacted("CLOUDFLARE_API_TOKEN")
      : Config.succeed(Redacted.make(configuredToken))
  const gatewayId = options.gatewayId ?? environment("CLOUDFLARE_AI_GATEWAY_ID")
  const model =
    options.model ?? environment("CLOUDFLARE_AI_MODEL") ?? "anthropic/claude-sonnet-4"
  // This endpoint publishes no model catalog on the path the chat request uses, so the window is
  // what the caller says and otherwise unknown. An invented figure would decide when compaction
  // fires for every Cloudflare model at once.
  const contextWindow =
    options.contextWindow ?? environmentNumber("CLOUDFLARE_AI_CONTEXT_WINDOW")
  const baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4/accounts"
  return openAiChatInference({
    id: `cloudflare-ai-gateway:${model}`,
    provider: "cloudflare-ai-gateway",
    model,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    endpoint: `${baseUrl.replace(/\/$/, "")}/${accountId ?? "missing"}/ai/v1/chat/completions`,
    apiKey: apiToken,
    ...(gatewayId === undefined ? {} : { headers: { "cf-aig-gateway-id": gatewayId } }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    // The account names the endpoint, so its absence is known here rather than at the request.
    ...(accountId === undefined
      ? {
          configurationError:
            "Cloudflare AI Gateway needs CLOUDFLARE_ACCOUNT_ID or accountId"
        }
      : {})
  })
}
