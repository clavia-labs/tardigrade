import type { HttpClient } from "effect/unstable/http"
import { Layer } from "effect"
import { OpenAiClient, OpenAiLanguageModel } from "@tardie/ai-openai"
import { requestKeys, type ProviderLayer } from "./layer"

// providerLayer supplies the openai Effect model without importing other providers (isolation.test.ts).
export const providerLayer: ProviderLayer = (options) => {
  if (options.provider !== "openai") throw new Error(`The openai layer cannot serve ${options.provider}; supply the matching providerLayer`)
  const client = { ...options.client, transformClient: (http: HttpClient.HttpClient) => requestKeys(options.client.transformClient?.(http) ?? http) }
  return OpenAiLanguageModel.layer(options.model).pipe(Layer.provide(OpenAiClient.layer(client)))
}
