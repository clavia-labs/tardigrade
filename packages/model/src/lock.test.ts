import { expect, test } from "bun:test"
import { modelCatalogForConfig, modelLockOf } from "./lock"
import { runtimeModelConfig as config, runtimeModelLock as lock } from "./testing/models"

test("a valid custom lock supplies the runtime snapshot", async () => {
  expect(await modelCatalogForConfig(config, modelLockOf(lock))).toEqual(lock.catalog)
  await expect(modelCatalogForConfig({ ...config, allow: [] }, lock)).rejects.toThrow("does not match")
})

test("duplicate providers and model IDs are rejected", () => {
  const provider = lock.catalog.providers[0]!
  expect(() => modelLockOf({ ...lock, catalog: { ...lock.catalog, providers: [provider, provider] } })).toThrow("duplicate model provider")
  expect(() => modelLockOf({ ...lock, catalog: { ...lock.catalog, providers: [{ ...provider, models: [...provider.models, ...provider.models] }] } })).toThrow("duplicate model local/qwen")
})

test("locks require a default entry and usable context metadata", async () => {
  await expect(modelCatalogForConfig(config, { ...lock, catalog: { ...lock.catalog, providers: [] } })).rejects.toThrow("absent from models.lock.json")
  const provider = lock.catalog.providers[0]!
  await expect(modelCatalogForConfig(config, { ...lock, catalog: { ...lock.catalog, providers: [{ ...provider, models: [{ id: "qwen", metadata: {} }] }] } })).rejects.toThrow("contextWindowTokens")
  expect(() => modelLockOf({ ...lock, schema: 2 })).toThrow()
})
