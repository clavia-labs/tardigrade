import { describe, expect, test } from "bun:test"
import {
  declaredModelMetadata,
  mergeModelMetadata,
  metadataValue,
  modelsDevCatalogOf,
  requireModelMetadata
} from "./metadata"

describe("model metadata", () => {
  test("models.dev rows preserve provider metadata and provenance", () => {
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
    }, "etag-1")
    const managed = { kind: "managed", catalog: "models.dev", revision: "etag-1" } as const
    expect(provider).toMatchObject({ id: "gateway", name: "A gateway", api: "https://gateway.example/v1" })
    expect(provider?.models).toEqual([{
      id: "provider/model",
      name: "A model",
      metadata: {
        contextWindowTokens: metadataValue(200_000, managed),
        maxOutputTokens: metadataValue(32_000, managed),
        inputModalities: metadataValue(["text", "image"], managed),
        outputModalities: metadataValue(["text"], managed),
        toolCall: metadataValue(true, managed),
        structuredOutput: metadataValue(true, managed),
        pricing: metadataValue({
          promptUsdPerToken: 0.000003,
          completionUsdPerToken: 0.000015,
          cachedPromptUsdPerToken: 0.0000003
        }, managed)
      }
    }])
  })

  test("sparse catalogs remain sparse and require an explicit context declaration", () => {
    const [model] = modelsDevCatalogOf({ provider: { models: { "model-only": { id: "model-only" } } } }, "etag-1")[0]!.models
    expect(model).toEqual({ id: "model-only", metadata: {} })
    expect(() => requireModelMetadata(model!)).toThrow("has no declared context window")
  })

  test("later metadata layers override individual fields and keep their source", () => {
    const discovered = modelsDevCatalogOf({ p: { models: { m: { id: "m", limit: { context: 100_000, output: 8_000 } } } } }, "r1")[0]!.models[0]!
    const declared = declaredModelMetadata({ contextWindowTokens: 120_000 }, "operator")
    const merged = mergeModelMetadata(discovered.metadata, declared)
    expect(merged.contextWindowTokens).toEqual({ value: 120_000, source: { kind: "declared", owner: "operator" } })
    expect(merged.maxOutputTokens).toEqual({ value: 8_000, source: { kind: "managed", catalog: "models.dev", revision: "r1" } })
  })

  test("declared policy rejects invalid token limits", () => {
    expect(() => declaredModelMetadata({ contextWindowTokens: 0 }, "operator")).toThrow("positive integer")
    expect(() => declaredModelMetadata({ contextWindowTokens: 100, maxOutputTokens: -1 }, "operator")).toThrow("positive integer")
  })
})
