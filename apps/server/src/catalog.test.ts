import { describe, expect, test } from "bun:test"
import { Effect, type Layer } from "effect"

import { loadModelCatalog, modelCatalogOf, type ModelCatalogLoadOptions } from "./catalog"
import { layerMemoryModelCatalogRepository, type ModelCatalogRepository } from "./catalog-store"

const source = {
  openai: {
    id: "openai",
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    models: {
      gpt: {
        id: "gpt",
        name: "GPT",
        limit: { context: 128_000, output: 16_000 },
        cost: { input: 1, output: 4, cache_read: 0.25 },
        tool_call: true,
        structured_output: true,
        modalities: { input: ["text", "image"], output: ["text"] }
      }
    }
  }
}

const options = (fetcher: typeof fetch, policy: ModelCatalogLoadOptions["policy"] = "refresh"): ModelCatalogLoadOptions => ({
  sourceUrl: "https://models.dev/api.json",
  timeoutMillis: 1_000,
  policy,
  fetch: fetcher,
  now: () => 1_700_000_000_000
})

const answering = (body: unknown, headers: Record<string, string> = {}): typeof fetch =>
  (async () => Response.json(body, { headers })) as unknown as typeof fetch

const run = (
  effect: ReturnType<typeof loadModelCatalog>,
  repository: Layer.Layer<ModelCatalogRepository>
) => Effect.runPromise(Effect.provide(effect, repository))

describe("modelCatalogOf", () => {
  test("projects every provider and model without private route data", () => {
    const catalog = modelCatalogOf(source, "catalog-1", 1)
    expect(catalog).toMatchObject({
      revision: "catalog-1",
      status: "fresh",
      providers: [{
        id: "openai",
        models: [{
          id: "gpt",
          metadata: {
            contextWindowTokens: 128_000,
            maxOutputTokens: 16_000,
            pricing: {
              promptUsdPerToken: 0.000_001,
              completionUsdPerToken: 0.000_004,
              cachedPromptUsdPerToken: 0.000_000_25
            },
            toolCall: true,
            structuredOutput: true,
            inputModalities: ["text", "image"],
            outputModalities: ["text"]
          }
        }]
      }]
    })
    expect(JSON.stringify(catalog)).not.toContain("apiKey")
    expect(JSON.stringify(catalog)).not.toContain("baseUrl")
  })

  test("refuses a document with no usable models", () => {
    expect(() => modelCatalogOf({}, "catalog-1", 1)).toThrow("no providers")
  })
})

describe("loadModelCatalog", () => {
  test("cache-first fetches once and reuses the validated snapshot", async () => {
    const repository = layerMemoryModelCatalogRepository()
    const loaded = await run(loadModelCatalog(options(answering(source, { etag: "catalog-7" }), "cache-first")), repository)
    expect(loaded.snapshot).toMatchObject({ revision: "catalog-7", status: "fresh" })
    const refused = (async () => { throw new Error("source should not be called") }) as unknown as typeof fetch
    const cached = await run(loadModelCatalog(options(refused, "cache-first")), repository)
    expect(cached.snapshot).toMatchObject({ revision: "catalog-7", status: "cached" })
    expect(cached.refreshError).toBeUndefined()
  })

  test("a failed refresh serves the last valid snapshot", async () => {
    const repository = layerMemoryModelCatalogRepository()
    await run(loadModelCatalog(options(answering(source, { etag: "catalog-7" }))), repository)
    const failed = (async () => { throw new Error("source unavailable") }) as unknown as typeof fetch
    const loaded = await run(loadModelCatalog(options(failed)), repository)
    expect(loaded.snapshot).toMatchObject({ revision: "catalog-7", status: "cached" })
    expect(loaded.refreshError).toBe("source unavailable")
  })

  test("an invalid refresh cannot replace the last valid snapshot", async () => {
    const repository = layerMemoryModelCatalogRepository()
    await run(loadModelCatalog(options(answering(source, { etag: "catalog-7" }))), repository)
    const loaded = await run(loadModelCatalog(options(answering({}, { etag: "catalog-8" }))), repository)
    expect(loaded.snapshot).toMatchObject({ revision: "catalog-7", status: "cached" })
    const cached = await run(loadModelCatalog(options(answering(source), "cache-first")), repository)
    expect(cached.snapshot).toMatchObject({ revision: "catalog-7" })
  })

  test("reports unavailable when neither source nor cache is valid", async () => {
    const failed = (async () => { throw new Error("source unavailable") }) as unknown as typeof fetch
    const loaded = await run(loadModelCatalog(options(failed)), layerMemoryModelCatalogRepository())
    expect(loaded.snapshot).toBeUndefined()
    expect(loaded.refreshError).toBe("source unavailable")
  })
})
