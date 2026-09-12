import { Effect, Layer } from "effect"
import { ProviderRequestKey } from "@clavia/tardigrade-agent/binding/settings"
export { ProviderRequestKey } from "@clavia/tardigrade-agent/binding/settings"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { OpenAiClient, OpenAiLanguageModel } from "@tardie/ai-openai"
import { OpenAiClient as CompatClient, OpenAiLanguageModel as CompatLanguageModel } from "@tardie/ai-openai-compat"
import { AnthropicClient, AnthropicLanguageModel } from "@tardie/ai-anthropic"
import { bedrockLayer } from "./bedrock"

export type ProviderOptions =
  | ({ readonly provider: "bedrock" } & Parameters<typeof bedrockLayer>[0])
  | { readonly provider: "openai-compat"; readonly client: Parameters<typeof CompatClient.layer>[0]; readonly model: Parameters<typeof CompatLanguageModel.layer>[0] }
  | { readonly provider: "openai"; readonly client: Parameters<typeof OpenAiClient.layer>[0]; readonly model: Parameters<typeof OpenAiLanguageModel.layer>[0] }
  | { readonly provider: "anthropic"; readonly client: Parameters<typeof AnthropicClient.layer>[0]; readonly model: Parameters<typeof AnthropicLanguageModel.layer>[0] }

const requestKeys = HttpClient.mapRequestEffect((request) => Effect.map(ProviderRequestKey, (key) =>
  key === undefined ? request : HttpClientRequest.setHeader(request, "Idempotency-Key", key)
))

// providerLayer supplies a provider with native configuration and an injected HTTP transport.
export const providerLayer = (options: ProviderOptions) => {
  if (options.provider === "bedrock") return bedrockLayer(options)
  const client = {
    ...options.client,
    transformClient: (client: HttpClient.HttpClient) => requestKeys(options.client.transformClient?.(client) ?? client)
  }
  return options.provider === "openai"
    ? OpenAiLanguageModel.layer(options.model).pipe(Layer.provide(OpenAiClient.layer(client)))
    : options.provider === "openai-compat"
    ? CompatLanguageModel.layer(options.model).pipe(Layer.provide(CompatClient.layer(client)))
    : AnthropicLanguageModel.layer(options.model).pipe(Layer.provide(AnthropicClient.layer(client)))
}
