import { Config, Redacted } from "effect"
import type { InferenceProvider } from "../infer"
import { environment, environmentNumber } from "./environment"
import { openAiChatInference } from "./openai-chat"

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
  return openAiChatInference({
    id: `cloudflare-ai-gateway:${model}`,
    provider: "cloudflare-ai-gateway",
    model,
    contextWindow,
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
