import { expect, test } from "bun:test"
import * as fc from "fast-check"
import { modelConfigOf } from "./config"
import { selectedModelFrom } from "./selection"
import type { ModelCatalogState } from "./catalog/index"

const config = (settings = {}) => modelConfigOf({ default: { provider: "test", model_id: "model" }, allow: "*", providers: { test: { baseUrl: "https://fixture.invalid", protocol: "openai-responses", env: ["KEY"], models: { model: settings } } } })
const catalog = (contextWindowTokens?: number): ModelCatalogState => ({ snapshot: { source: "models.dev", revision: "r", refreshedAt: 1, status: "fresh", providers: [{ id: "test", name: "Test", env: [], models: [{ id: "model", metadata: contextWindowTokens === undefined ? {} : { contextWindowTokens } }] }] } })

test("context capacity comes from catalog metadata and cannot be configured as a request setting", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), capacity => {
    expect(selectedModelFrom(config(), { KEY: "secret" }, catalog(capacity)).contextWindowTokens).toBe(capacity)
    expect(() => config({ contextWindowTokens: capacity })).toThrow("unsupported settings")
  }))
})

test.each([undefined, 0, -1, 0.5, Infinity, NaN])("missing or invalid catalog capacity fails (%s)", capacity => {
  expect(() => selectedModelFrom(config(), { KEY: "secret" }, catalog(capacity))).toThrow(
    capacity === undefined ? "no context window" : "positive safe integer"
  )
})
