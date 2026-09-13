import { type ModelConfig } from "../config"
import type { ModelCatalog } from "../catalog/schema"

export const httpRegistrySource = { local: { id: "local", models: { test: { id: "test", limit: { context: 32000 } } } } }

export const customModelConfig: ModelConfig = {
  allow: "*", default: { provider: "local", model_id: "custom" },
  providers: { local: {
    protocol: "openai-chat-completions", baseUrl: "http://localhost:8080/v1", env: ["API_KEY"],
    models: { custom: { metadata: { contextWindowTokens: 32000, toolCall: true } } }
  } }
}
export const registryCatalog: ModelCatalog = {
  source: "custom", revision: "fixture-1", refreshedAt: 0, status: "cached",
  providers: [{ id: "local", name: "Local", env: [], models: [
    { id: "registered", metadata: { contextWindowTokens: 128000 } },
    { id: "allowed", metadata: { contextWindowTokens: 64000 } }
  ] }]
}

export const runtimeModelConfig: ModelConfig = {
  allow: "*", default: { provider: "local", model_id: "qwen" },
  providers: { local: { baseUrl: "http://localhost:8080/v1", protocol: "openai-chat-completions", env: ["API_KEY"] } }
}
export const runtimeModelLock = {
  schema: 2 as const,
  providers: { local: { protocol: "openai-chat-completions" as const, baseUrl: "http://localhost:8080/v1", env: ["API_KEY"] } },
  models: [{ provider: "local", model_id: "qwen", contextWindowTokens: 32768, toolCall: true }]
}
