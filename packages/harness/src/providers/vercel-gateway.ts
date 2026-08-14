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

export const vercelGatewayInference = (
  options: VercelGatewayInferenceOptions = {}
): InferenceProvider => {
  const configured = options.apiKey ?? environment("AI_GATEWAY_API_KEY")
  const apiKey = configured === "" ? undefined : configured
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
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(apiKey === undefined
      ? {
          configurationError:
            "Vercel AI Gateway needs AI_GATEWAY_API_KEY or an apiKey passed to vercelGatewayInference"
        }
      : {})
  })
}
