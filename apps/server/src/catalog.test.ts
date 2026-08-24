import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadModelCatalog, modelCatalogOf, type ModelCatalogLoadOptions } from "./catalog"

let root = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tardigrade-catalog-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

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

const options = (fetcher: typeof fetch): ModelCatalogLoadOptions => ({
  sourceUrl: "https://models.dev/api.json",
  cachePath: join(root, "models.json"),
  timeoutMillis: 1_000,
  fetch: fetcher,
  now: () => 1_700_000_000_000
})

const answering = (body: unknown, headers: Record<string, string> = {}): typeof fetch =>
  (async () => Response.json(body, { headers })) as unknown as typeof fetch

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
  test("refreshes and persists one validated snapshot", async () => {
    const loaded = await loadModelCatalog(options(answering(source, { etag: "catalog-7" })))
    expect(loaded.snapshot).toMatchObject({ revision: "catalog-7", status: "fresh" })
    expect(JSON.parse(await readFile(join(root, "models.json"), "utf8"))).toMatchObject({
      schema: 1,
      snapshot: loaded.snapshot
    })
  })

  test("a failed refresh serves the last valid snapshot", async () => {
    await loadModelCatalog(options(answering(source, { etag: "catalog-7" })))
    const failed = (async () => { throw new Error("source unavailable") }) as unknown as typeof fetch
    const loaded = await loadModelCatalog(options(failed))
    expect(loaded.snapshot).toMatchObject({ revision: "catalog-7", status: "cached" })
    expect(loaded.refreshError).toBe("source unavailable")
  })

  test("an invalid refresh cannot replace the last valid snapshot", async () => {
    await loadModelCatalog(options(answering(source, { etag: "catalog-7" })))
    const loaded = await loadModelCatalog(options(answering({}, { etag: "catalog-8" })))
    expect(loaded.snapshot).toMatchObject({ revision: "catalog-7", status: "cached" })
    expect(JSON.parse(await readFile(join(root, "models.json"), "utf8"))).toMatchObject({
      snapshot: { revision: "catalog-7" }
    })
  })

  test("reports unavailable when neither source nor cache is valid", async () => {
    const failed = (async () => { throw new Error("source unavailable") }) as unknown as typeof fetch
    const loaded = await loadModelCatalog(options(failed))
    expect(loaded.snapshot).toBeUndefined()
    expect(loaded.refreshError).toBe("source unavailable")
  })
})
