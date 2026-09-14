import { validatedConfig } from "./options"
import type { HttpClient } from "effect/unstable/http"
import { Layer } from "effect"
import { OpenRouterClient, OpenRouterLanguageModel } from "@tardie/ai-openrouter"
import { requestKeys, type ProviderLayer } from "./layer"

// providerLayer supplies OpenRouter's native reasoning replay and routing metadata (openrouter.test.ts).
export const providerLayer: ProviderLayer = (options) => {
  if (options.provider !== "openrouter") throw new Error(`The openrouter layer cannot serve ${options.provider}; supply the matching providerLayer`)
  const client = { ...options.client, transformClient: (http: HttpClient.HttpClient) => requestKeys(options.client.transformClient?.(http) ?? http) }
  return OpenRouterLanguageModel.layer({ ...options.model, config: validatedConfig(OpenRouterLanguageModel.ModelConfigSchema, options.model.config, options.unvalidatedConfig) }).pipe(Layer.provide(OpenRouterClient.layer(client)))
}
