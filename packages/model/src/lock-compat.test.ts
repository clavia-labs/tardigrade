import { expect, test } from "bun:test"
import { canonicalModelConfig, modelConfigOf } from "./config"
import { sha256Of } from "./digest"
import { modelLockSourceOf, upgradeModelLock } from "./lock-compat"

const config = modelConfigOf({
  default: { provider: "custom", model_id: "small" }, allow: "*",
  providers: { custom: { protocol: "openai-chat-completions", baseUrl: "https://custom.test/v1", env: ["CUSTOM_KEY"],
    models: { small: { options: { temperature: 0.2 } } }
  } }
})

const legacy = async () => ({
  schema: 1,
  configDigest: await sha256Of(canonicalModelConfig(config)),
  catalog: {
    source: "custom", revision: "saved", refreshedAt: 1, status: "cached",
    providers: [{ id: "custom", name: "Custom", env: [], models: [{ id: "small", metadata: {
      contextWindowTokens: 32000, maxOutputTokens: 4000, pricing: { promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002 }
    } }] }]
  }
})

test("v1 upcast preserves saved model metadata, manifest connections and options", async () => {
  const source = modelLockSourceOf(await legacy())
  const lock = await upgradeModelLock(source, config)
  expect(lock.schema).toBe(2)
  expect(lock.providers.custom).toEqual({ protocol: "openai-chat-completions", baseUrl: "https://custom.test/v1", env: ["CUSTOM_KEY"] })
  expect(lock.models).toEqual([{ provider: "custom", model_id: "small", contextWindowTokens: 32000, maxOutputTokens: 4000, pricing: { promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002 }, options: { temperature: 0.2 } }])
  expect(await upgradeModelLock(modelLockSourceOf(lock), undefined)).toEqual(lock)
  expect(source.schema).toBe(1)
})

test("v1 upcast refuses mismatched manifests and missing context metadata", async () => {
  const value = await legacy()
  const source = modelLockSourceOf(value)
  await expect(upgradeModelLock(source, { ...config, allow: [] })).rejects.toThrow()
  await expect(upgradeModelLock(source, { ...config, providers: { custom: { ...config.providers.custom, baseUrl: "https://changed.test" } } })).rejects.toThrow("does not match model configuration")
  value.catalog.providers[0]!.models[0]!.metadata = {} as typeof value.catalog.providers[0]["models"][0]["metadata"]
  await expect(upgradeModelLock(modelLockSourceOf(value), config)).rejects.toThrow("contextWindowTokens")
  expect(() => modelLockSourceOf({ schema: 1, catalog: value.catalog })).toThrow("models.lock.json is invalid")
  expect(() => modelLockSourceOf({ schema: 3 })).toThrow("unsupported schema 3")
})
