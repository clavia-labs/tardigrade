import { Effect, Layer, Stream } from "effect"
import { ProviderRequestKey } from "@clavia/tardigrade-model/settings"
export { ProviderRequestKey } from "@clavia/tardigrade-model/settings"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { OpenRouterClient, OpenRouterLanguageModel } from "@tardie/ai-openrouter"
import type { OpenAiClient, OpenAiLanguageModel } from "@tardie/ai-openai"
import type { OpenAiClient as CompatClient, OpenAiLanguageModel as CompatLanguageModel } from "@tardie/ai-openai-compat"
import type { AnthropicClient, AnthropicLanguageModel } from "@tardie/ai-anthropic"
import type { BedrockLanguageModel } from "@tardie/ai-bedrock"
import { LanguageModel } from "effect/unstable/ai"
import { unknownModelError } from "@clavia/tardigrade-model/error"
import type { StreamBounds } from "../stream/policy"

export type ProviderOptions = { readonly unvalidatedConfig?: unknown } & (
  | { readonly provider: "openrouter"; readonly client: Parameters<typeof OpenRouterClient.layer>[0]; readonly model: Parameters<typeof OpenRouterLanguageModel.layer>[0] }
  | ({ readonly provider: "bedrock"; readonly gateway?: { readonly apiKey: string; readonly bounds: StreamBounds } } & Parameters<typeof BedrockLanguageModel.layer>[0])
  | { readonly provider: "openai-compat"; readonly client: Parameters<typeof CompatClient.layer>[0]; readonly model: Parameters<typeof CompatLanguageModel.layer>[0] }
  | { readonly provider: "openai"; readonly client: Parameters<typeof OpenAiClient.layer>[0]; readonly model: Parameters<typeof OpenAiLanguageModel.layer>[0] }
  | { readonly provider: "anthropic"; readonly client: Parameters<typeof AnthropicClient.layer>[0]; readonly model: Parameters<typeof AnthropicLanguageModel.layer>[0] }

)

export const requestKeys = HttpClient.mapRequestEffect((request) => Effect.map(ProviderRequestKey, (key) =>
  key === undefined ? request : HttpClientRequest.setHeader(request, "Idempotency-Key", key)
))

export type ProviderLayer = (options: ProviderOptions) => Layer.Layer<LanguageModel.LanguageModel, never, HttpClient.HttpClient>

// providerLayer loads a selected provider in Bun; Workers supply an explicit factory (isolation.test.ts).
export const providerLayer: ProviderLayer = (options) => Layer.unwrap(Effect.tryPromise(async () => {
  if ((globalThis as { Bun?: unknown }).Bun === undefined) throw new Error(`Import tardie/model/providers/${options.provider} and supply its providerLayer to workerModelServices`)
  const path = `./${options.provider}.ts`
  try {
    const loaded: { readonly providerLayer: ProviderLayer } = await import(/* @vite-ignore */ path)
    return loaded.providerLayer(options)
  } catch (cause) {
    const packages = options.provider === "bedrock" ? "@tardie/ai-bedrock @smithy/fetch-http-handler @smithy/node-http-handler" : `@tardie/ai-${options.provider}`
    throw new Error(`Cannot load the ${options.provider} provider; install compatible ${packages} packages. ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}).pipe(Effect.catch((error) => Effect.succeed(failedProviderLayer(error.cause)))))

// failedProviderLayer reports assembly failures through the model error channel (isolation.test.ts).
export const failedProviderLayer = (cause: unknown) => Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
  generateText: () => Effect.fail(unknownModelError(cause)),
  streamText: () => Stream.fail(unknownModelError(cause))
}))
