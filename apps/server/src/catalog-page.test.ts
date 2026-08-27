import { describe, expect, test } from "bun:test"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"

import {
  DEFAULT_CATALOG_PAGE_LIMIT,
  modelsPageOf,
  providersPageOf
} from "./catalog-page"
import type { ProviderAvailabilities } from "./catalog-availability"

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
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", metadata: { contextWindowTokens: 200_000, pricing: { promptUsdPerToken: 0.000_003, completionUsdPerToken: 0.000_015 }, toolCall: true } },
        { id: "openai/gpt", name: "GPT", metadata: { contextWindowTokens: 128_000, pricing: { promptUsdPerToken: 0.000_002, completionUsdPerToken: 0.000_01 } } },
        { id: "unpriced-model", metadata: {} }
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

const availability: ProviderAvailabilities = {
  openrouter: { status: "available" },
  "private-gateway": { status: "unavailable", reason: "credential_missing" }
}

describe("provider catalog pages", () => {
  test("states known and custom provider requirements", () => {
    const page = providersPageOf(catalog, availability, { search: "gateway" })
    expect(page.limit).toBe(DEFAULT_CATALOG_PAGE_LIMIT)
    expect(page.items.find((provider) => provider.id === "private-gateway")).toMatchObject({
      env: ["PRIVATE_MODEL_KEY"],
      required: ["baseUrl", "protocol", "env"],
      availability: { status: "unavailable", reason: "credential_missing" }
    })
    expect(page.items.find((provider) => provider.id === "cloudflare-ai-gateway")).toMatchObject({
      protocol: "openai-responses",
      required: ["baseUrl", "env"]
    })
  })

  test("states Bedrock region and endpoint requirements", () => {
    expect(providersPageOf(catalog, availability, { search: "bedrock" }).items[0]).toMatchObject({
      id: "amazon-bedrock",
      protocol: "bedrock-converse",
      required: ["baseUrl", "env", "region"]
    })
  })

  test("limits agent discovery to available providers", () => {
    expect(providersPageOf(catalog, availability, { availability: "available" }).items.map((provider) => provider.id)).toEqual([
      "openrouter"
    ])
  })

  test("limits agent discovery to its effective model set", () => {
    const models = {
      allow: [{ provider: "openrouter", model_ids: ["openai/gpt"] }]
    } as const
    expect(providersPageOf(catalog, availability, { availability: "available", models }).items.map((provider) => provider.id)).toEqual([
      "openrouter"
    ])
  })
})

describe("model catalog pages", () => {
  test("filters models and follows an opaque cursor", () => {
    const first = modelsPageOf(catalog, availability, { provider: "openrouter", limit: 1 })
    expect(first.items.map((model) => model.id)).toEqual(["anthropic/claude-sonnet"])
    expect(typeof first.next_cursor).toBe("string")
    const second = modelsPageOf(catalog, availability, { provider: "openrouter", limit: 1, cursor: first.next_cursor })
    expect(second.items.map((model) => model.id)).toEqual(["openai/gpt"])
    expect(typeof second.next_cursor).toBe("string")
    const third = modelsPageOf(catalog, availability, { provider: "openrouter", limit: 1, cursor: second.next_cursor })
    expect(third.items.map((model) => model.id)).toEqual(["unpriced-model"])
    expect(third.next_cursor).toBeUndefined()
  })

  test("lists models from available providers", () => {
    expect(modelsPageOf(catalog, availability, { availability: "available" }).items.map((model) => model.provider)).toEqual([
      "openrouter",
      "openrouter",
      "openrouter"
    ])
  })

  test("keeps the host catalog complete", () => {
    expect(modelsPageOf(catalog, availability).items.map((model) => model.provider)).toEqual([
      "openrouter",
      "openrouter",
      "openrouter",
      "private-gateway"
    ])
  })

  test("reports the policy used by the discovery surface", () => {
    const policy = {
      default: { provider: "openrouter", model_id: "openai/gpt" },
      allow: [{ provider: "openrouter", model_ids: ["openai/gpt"] }]
    } as const
    expect(modelsPageOf(catalog, availability, { policy }).policy).toEqual(policy)
    expect(providersPageOf(catalog, availability, { models: policy }).policy).toEqual(policy)
  })

  test("searches within the effective model set", () => {
    expect(modelsPageOf(catalog, availability, {
      models: { allow: [{ provider: "openrouter", model_ids: ["openai/gpt"] }] }
    }).items.map((model) => `${model.provider}/${model.id}`)).toEqual(["openrouter/openai/gpt"])
  })

  test("searches model IDs and names without case sensitivity", () => {
    expect(modelsPageOf(catalog, availability, { search: "CLAUDE" }).items.map((model) => model.id)).toEqual([
      "anthropic/claude-sonnet"
    ])
  })

  test("sorts by a selected price before paging", () => {
    const ascending = modelsPageOf(catalog, availability, {
      sort: "completionUsdPerToken",
      limit: 2,
      availability: "available"
    })
    expect(ascending.items.map((model) => model.id)).toEqual(["openai/gpt", "anthropic/claude-sonnet"])
    expect(typeof ascending.next_cursor).toBe("string")
    const remaining = modelsPageOf(catalog, availability, {
      sort: "completionUsdPerToken",
      limit: 2,
      cursor: ascending.next_cursor,
      availability: "available"
    })
    expect(remaining.items.map((model) => model.id)).toEqual(["unpriced-model"])

    expect(modelsPageOf(catalog, availability, {
      availability: "available",
      sort: "promptUsdPerToken",
      order: "desc",
      unpriced: "first"
    }).items.map((model) => model.id)).toEqual(["unpriced-model", "anthropic/claude-sonnet", "openai/gpt"])
  })

  test("rejects cursors used with another query or revision", () => {
    const cursor = modelsPageOf(catalog, availability, { provider: "openrouter", limit: 1 }).next_cursor
    expect(() => modelsPageOf(catalog, availability, { provider: "private-gateway", cursor })).toThrow("another query")
    expect(() => modelsPageOf({ ...catalog, revision: "catalog-2" }, availability, { provider: "openrouter", cursor })).toThrow(
      "restart at revision"
    )
  })
})
