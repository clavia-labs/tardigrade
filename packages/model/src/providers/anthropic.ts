import type { HttpClient } from "effect/unstable/http"
import { Layer } from "effect"
import { AnthropicClient, AnthropicLanguageModel } from "@tardie/ai-anthropic"
import { requestKeys, type ProviderLayer } from "./layer"

// providerLayer supplies the anthropic Effect model without importing other providers (isolation.test.ts).
export const providerLayer: ProviderLayer = (options) => {
  if (options.provider !== "anthropic") throw new Error(`The anthropic layer cannot serve ${options.provider}; supply the matching providerLayer`)
  const client = { ...options.client, transformClient: (http: HttpClient.HttpClient) => requestKeys(options.client.transformClient?.(http) ?? http) }
  return AnthropicLanguageModel.layer(options.model).pipe(Layer.provide(AnthropicClient.layer(client)))
}
