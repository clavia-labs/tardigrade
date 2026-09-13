import { expect, test } from "bun:test"
import { modelConfigOf } from "./config"
import { selectedModelFrom } from "./selection"
import type { ModelCatalogState } from "./catalog/index"

const config = (contextWindowTokens?: number) => modelConfigOf({ default: { provider: "test", model_id: "model" }, allow: "*", providers: { test: { baseUrl: "https://fixture.invalid", protocol: "openai-responses", env: ["KEY"], models: { model: contextWindowTokens === undefined ? {} : { contextWindowTokens } } } } })
const catalog = (contextWindowTokens?: number): ModelCatalogState => ({ snapshot: { source: "models.dev", revision: "r", refreshedAt: 1, status: "fresh", providers: [{ id: "test", name: "Test", env: [], models: [{ id: "model", metadata: contextWindowTokens === undefined ? {} : { contextWindowTokens } }] }] } })

test("context limit uses host override then catalog, otherwise fails", () => {
  expect(selectedModelFrom(config(100), { KEY: "secret" }, catalog(200)).contextWindowTokens).toBe(100)
  expect(selectedModelFrom(config(100), { KEY: "secret" }, catalog()).contextWindowTokens).toBe(100)
  expect(selectedModelFrom(config(), { KEY: "secret" }, catalog(200)).contextWindowTokens).toBe(200)
  expect(() => selectedModelFrom(config(), { KEY: "secret" }, catalog())).toThrow("no context window")
})

test("invalid context overrides cannot fall back to the catalog", () => {
  for (const value of [0, -1, 0.5, Infinity, NaN]) expect(() => config(value)).toThrow("positive safe integer")
  const direct = config(100)
  expect(() => selectedModelFrom({ ...direct, providers: { test: { ...direct.providers.test!, models: { model: { contextWindowTokens: 0 } } } } }, { KEY: "secret" }, catalog(200))).toThrow("positive safe integer")
})
