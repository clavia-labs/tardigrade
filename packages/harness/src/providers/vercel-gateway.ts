import { Config, Redacted } from "effect"
import type { InferenceProvider } from "../infer"
import { environment, environmentNumber } from "./environment"
import { openAiChatInference } from "./openai-chat"

export interface VercelGatewayInferenceOptions {
  readonly apiKey?: string
  readonly model?: string
  readonly contextWindow?: number
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

// The key is the one secret here, so it is the one setting read as a `Config`: it is resolved where
// it is used and stays redacted until the request carries it. The model and the context window are
// read at construction because `state` reports them synchronously, and neither is a secret.
export const vercelGatewayInference = (
  options: VercelGatewayInferenceOptions = {}
): InferenceProvider => {
  const configured = options.apiKey === "" ? undefined : options.apiKey
  const apiKey =
    configured === undefined
      ? Config.redacted("AI_GATEWAY_API_KEY")
      : Config.succeed(Redacted.make(configured))
  const model = options.model ?? environment("AI_GATEWAY_MODEL") ?? "anthropic/claude-sonnet-4.6"
  const contextWindow =
    options.contextWindow ?? environmentNumber("AI_GATEWAY_CONTEXT_WINDOW") ?? 200_000
  const baseUrl = options.baseUrl ?? "https://ai-gateway.vercel.sh/v1"
  return openAiChatInference({
    id: `vercel-ai-gateway:${model}`,
    provider: "vercel-ai-gateway",
    model,
    contextWindow,
    endpoint: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  })
}
