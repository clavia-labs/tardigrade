import { describe, expect, test } from "bun:test"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"

import {
  DEFAULT_CATALOG_PAGE_LIMIT,
  modelsPageOf,
  providersPageOf
} from "./catalog-page"

const catalog: ModelCatalog = {
  source: "models.dev",
  revision: "catalog-1",
  refreshedAt: 1,
  status: "fresh",
  providers: [
    {
      id: "openrouter",
      name: "OpenRouter",
      env: ["OPENROUTER_API_KEY"],
      models: [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", metadata: { contextWindowTokens: 200_000, toolCall: true } },
        { id: "openai/gpt", name: "GPT", metadata: { contextWindowTokens: 128_000 } }
      ]
    },
    {
      id: "private-gateway",
      name: "Private Gateway",
      env: ["PRIVATE_MODEL_KEY"],
      models: [{ id: "private-model", metadata: {} }]
    }
  ]
}

describe("provider catalog pages", () => {
  test("states known and custom provider requirements", () => {
    const page = providersPageOf(catalog, { search: "gateway" })
    expect(page.limit).toBe(DEFAULT_CATALOG_PAGE_LIMIT)
    expect(page.items.find((provider) => provider.id === "private-gateway")).toMatchObject({
      env: ["PRIVATE_MODEL_KEY"],
      required: ["baseUrl", "protocol", "env"]
    })
    expect(page.items.find((provider) => provider.id === "cloudflare-ai-gateway")).toMatchObject({
      protocol: "openai-responses",
      required: ["baseUrl", "env"]
    })
  })

  test("states Bedrock region and endpoint requirements", () => {
    expect(providersPageOf(catalog, { search: "bedrock" }).items[0]).toMatchObject({
      id: "amazon-bedrock",
      protocol: "bedrock-converse",
      required: ["baseUrl", "env", "region"]
    })
  })
})

describe("model catalog pages", () => {
  test("filters models and follows an opaque cursor", () => {
    const first = modelsPageOf(catalog, { provider: "openrouter", limit: 1 })
    expect(first.items.map((model) => model.id)).toEqual(["anthropic/claude-sonnet"])
    expect(typeof first.next_cursor).toBe("string")
    const second = modelsPageOf(catalog, { provider: "openrouter", limit: 1, cursor: first.next_cursor })
    expect(second.items.map((model) => model.id)).toEqual(["openai/gpt"])
    expect(second.next_cursor).toBeUndefined()
  })

  test("searches model IDs and names without case sensitivity", () => {
    expect(modelsPageOf(catalog, { search: "CLAUDE" }).items.map((model) => model.id)).toEqual([
      "anthropic/claude-sonnet"
    ])
  })

  test("rejects cursors used with another query or revision", () => {
    const cursor = modelsPageOf(catalog, { provider: "openrouter", limit: 1 }).next_cursor
    expect(() => modelsPageOf(catalog, { provider: "private-gateway", cursor })).toThrow("another query")
    expect(() => modelsPageOf({ ...catalog, revision: "catalog-2" }, { provider: "openrouter", cursor })).toThrow(
      "restart at revision"
    )
  })
})
