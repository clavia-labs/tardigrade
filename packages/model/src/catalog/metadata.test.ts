import { describe, expect, test } from "bun:test"
import { modelsDevCatalogOf } from "./metadata"

describe("model metadata", () => {
  test("models.dev rows preserve public provider and model fields", () => {
    const [provider] = modelsDevCatalogOf({
      gateway: {
        id: "gateway",
        name: "A gateway",
        api: "https://gateway.example/v1",
        env: ["GATEWAY_API_KEY"],
        models: {
          "provider/model": {
            id: "provider/model",
            name: "A model",
            tool_call: true,
            structured_output: true,
            limit: { context: 200_000, output: 32_000 },
            modalities: { input: ["text", "image"], output: ["text"] },
            cost: { input: 3, output: 15, cache_read: 0.3 }
          }
        }
      }
    })
    expect(provider).toEqual({
      id: "gateway",
      name: "A gateway",
      api: "https://gateway.example/v1",
      env: ["GATEWAY_API_KEY"],
      models: [{
        id: "provider/model",
        name: "A model",
        metadata: {
          contextWindowTokens: 200_000,
          maxOutputTokens: 32_000,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          toolCall: true,
          structuredOutput: true,
          pricing: {
            promptUsdPerToken: 0.000003,
            completionUsdPerToken: 0.000015,
            cachedPromptUsdPerToken: 0.0000003
          }
        }
      }]
    })
  })

  test("sparse catalogs remain sparse", () => {
    const [model] = modelsDevCatalogOf({
      provider: { models: { "model-only": { id: "model-only" } } }
    })[0]!.models
    expect(model).toEqual({ id: "model-only", metadata: {} })
  })
})
