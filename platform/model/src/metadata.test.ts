import { describe, expect, test } from "bun:test"
import {
  declaredModelMetadata,
  discoveredModelsOf,
  mergeModelMetadata,
  metadataValue,
  requireModelMetadata,
  type ModelMetadataSource
} from "./metadata"

const source: ModelMetadataSource = {
  kind: "discovered",
  url: "https://gateway.example/v1/models",
  revision: "etag-1"
}

describe("model metadata", () => {
  test("rich OpenAI-style model rows preserve values and provenance", () => {
    expect(discoveredModelsOf({
      data: [{
        id: "provider/model",
        name: "A model",
        context_length: 200_000,
        top_provider: { max_completion_tokens: 32_000 },
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["tools", "structured_outputs"],
        pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" }
      }]
    }, source)).toEqual([{
      id: "provider/model",
      name: "A model",
      metadata: {
        contextWindowTokens: metadataValue(200_000, source),
        maxOutputTokens: metadataValue(32_000, source),
        inputModalities: metadataValue(["text", "image"], source),
        outputModalities: metadataValue(["text"], source),
        output: metadataValue({ guarantee: "native", withTools: true }, source),
        pricing: metadataValue({
          promptUsdPerToken: 0.000003,
          completionUsdPerToken: 0.000015,
          cachedPromptUsdPerToken: 0.0000003
        }, source)
      }
    }])
  })

  test("sparse catalogs remain sparse and require an explicit context declaration", () => {
    const [model] = discoveredModelsOf({ data: [{ id: "model-only" }] }, source)
    expect(model).toEqual({ id: "model-only", metadata: {} })
    expect(() => requireModelMetadata(model!)).toThrow("has no declared context window")
  })

  test("later metadata layers override individual fields and keep their source", () => {
    const discovered = discoveredModelsOf({ data: [{ id: "m", context_window: 100_000, max_tokens: 8_000 }] }, source)[0]!
    const declared = declaredModelMetadata({ contextWindowTokens: 120_000 }, "operator")
    const merged = mergeModelMetadata(discovered.metadata, declared)
    expect(merged.contextWindowTokens).toEqual({ value: 120_000, source: { kind: "declared", owner: "operator" } })
    expect(merged.maxOutputTokens).toEqual({ value: 8_000, source })
  })

  test("declared policy rejects invalid token limits", () => {
    expect(() => declaredModelMetadata({ contextWindowTokens: 0 }, "operator")).toThrow("positive integer")
    expect(() => declaredModelMetadata({ contextWindowTokens: 100, maxOutputTokens: -1 }, "operator")).toThrow("positive integer")
  })
})
