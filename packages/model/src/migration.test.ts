import { expect, test } from "bun:test"
import { migrateModelLock } from "./migration"
import { customModelConfig, registryCatalog } from "./testing/models"

test("migration combines saved registry metadata and authored definitions offline", () => {
  const lock = migrateModelLock({ schema: 1, configDigest: "old", catalog: registryCatalog }, customModelConfig, "https://registry.example/api.json")
  expect(lock.schema).toBe(2)
  expect(lock.providers.local).toEqual({ protocol: "openai-chat-completions", baseUrl: "http://localhost:8080/v1", env: ["API_KEY"] })
  expect(lock.models).toContainEqual({ provider: "local", model_id: "registered", contextWindowTokens: 128000, source: "https://registry.example/api.json" })
  expect(lock.models).toContainEqual({ provider: "local", model_id: "custom", contextWindowTokens: 32000, toolCall: true })
})

test("migration refuses an incomplete saved definition or absent default", () => {
  const legacy = { schema: 1, catalog: { ...registryCatalog, providers: [{ ...registryCatalog.providers[0]!, models: [{ id: "registered", metadata: {} }] }] } }
  expect(() => migrateModelLock(legacy, customModelConfig)).toThrow()
  expect(() => migrateModelLock({ schema: 1, catalog: registryCatalog }, { ...customModelConfig, default: { provider: "local", model_id: "missing" } })).toThrow("absent")
})
