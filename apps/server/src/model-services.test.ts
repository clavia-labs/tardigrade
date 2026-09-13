import { layerModelLock, ModelLock } from "@clavia/tardigrade-model/lock"
import { inferenceClient } from "@clavia/tardigrade-agent/testing/inference"
import { expect, test, spyOn } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/unstable/http"

import { ModelSelection } from "@clavia/tardigrade-model/settings"
import { providerLayer } from "@clavia/tardigrade-model/providers/openai"
import { bunModelServices } from "./model-services"

test("Bun model services resolve configuration and supply Effect inference by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-services-"))
  try {
    const configFile = join(directory, "wrangler.jsonc")
    await writeFile(configFile, JSON.stringify({ vars: { TARDIGRADE_CONFIG: { models: {
      allow: "*",
      default: { provider: "openai", model_id: "gpt" }
    } } } }))
    await writeFile(join(directory, "models.lock.json"), JSON.stringify({
      schema: 2,
      providers: { openai: { protocol: "openai-responses", baseUrl: "https://example.test/v1", env: ["TEST_MODEL_KEY"] } },
      models: [{ provider: "openai", model_id: "gpt", contextWindowTokens: 128000, maxOutputTokens: 16000 }]
    }))
    const fetching = spyOn(globalThis, "fetch").mockRejectedValue(new Error("registry must not be contacted"))
    const services = await bunModelServices({
      configFile: pathToFileURL(configFile),
      model: { providerLayer: (options) => {
        expect(options.model.config).toMatchObject({ max_output_tokens: 1234 })
        return providerLayer(options)
      }, configure: (selected) => {
        expect(selected.model_id).toBe("gpt")
        return { maxOutputTokens: 1234, timeout: { idleMs: 12345 } }
      } },
      env: { PORT: "4321", TEST_MODEL_KEY: "test-secret", TARDIGRADE_MODEL_CATALOG_CACHE: join(directory, "catalog.json") },

    })
    expect(services.config.port).toBe(4321)
    expect(services.config.modelLockPath).toBe(join(directory, "models.lock.json"))
    expect(fetching).not.toHaveBeenCalled()
    fetching.mockRestore()
    const catalog = await Effect.runPromise(services.api.catalog.read)
    expect(catalog.policy.default).toEqual({ provider: "openai", model_id: "gpt" })
    expect(catalog.snapshot?.providers[0]?.models[0]?.id).toBe("gpt")
    expect(JSON.stringify(catalog)).not.toContain("test-secret")
    await Effect.runPromise(Effect.gen(function*() {
      const infer = yield* inferenceClient
      expect(infer.resolve?.()).toMatchObject({ model: { provider: "openai", model_id: "gpt" }, contextWindowTokens: 128000, maxOutputTokens: 16000 })
      const selection = yield* ModelSelection
      const settings = yield* selection.settings!()
      expect(settings.policy).toMatchObject({ maxOutputTokens: 1234, timeout: { idleMs: 12345 } })
      yield* FileSystem.FileSystem
      yield* Path.Path
      yield* HttpClient.HttpClient
    }).pipe(Effect.provide(services.layers)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Bun model services reject missing explicit configuration before catalog loading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-services-"))
  try {
    const missing = join(directory, "missing.jsonc")
    for (const source of [{ configFile: missing, env: {} }, { env: { TARDIGRADE_CONFIG_PATH: missing } }]) {
      await expect(bunModelServices(source)).rejects.toThrow("does not exist")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Bun rejects missing and stale locks without a registry fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-services-"))
  try {
    const configFile = join(directory, "wrangler.jsonc")
    const models = { allow: "*", default: { provider: "local", model_id: "qwen" } }
    await writeFile(configFile, JSON.stringify({ vars: { TARDIGRADE_CONFIG: { models } } }))
    await expect(bunModelServices({ configFile, env: {} })).rejects.toThrow()
    const lockFile = join(directory, "custom.lock.json")
    await writeFile(lockFile, JSON.stringify({ schema: 2, providers: {}, models: [] }))
    await expect(bunModelServices({ configFile, lockFile, env: {} })).rejects.toThrow("absent")
    await writeFile(lockFile, "{")
    await expect(bunModelServices({ configFile, lockFile, env: {} })).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Bun can boot without models or registry configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-services-"))
  try {
    const configFile = join(directory, "wrangler.jsonc")
    await writeFile(configFile, "{}")
    const services = await bunModelServices({ configFile, env: { TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS: "invalid" } })
    expect((await Effect.runPromise(services.api.catalog.read)).snapshot?.providers).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Bun consumes an in-memory ModelLock layer without a lock file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-services-memory-"))
  try {
    const configFile = join(directory, "wrangler.jsonc")
    await writeFile(configFile, JSON.stringify({ vars: { TARDIGRADE_CONFIG: { models: { allow: "*", default: { provider: "openai", model_id: "gpt" } } } } }))
    const lock = { schema: 2, providers: { openai: { protocol: "openai-responses", baseUrl: "https://example.test/v1", env: ["TEST_MODEL_KEY"] } }, models: [{ provider: "openai", model_id: "gpt", contextWindowTokens: 32000 }] }
    const services = await bunModelServices({ configFile, env: { TEST_MODEL_KEY: "secret" }, lock: layerModelLock(lock), model: { providerLayer } })
    expect(services.config.model.providers.openai?.baseUrl).toBe("https://example.test/v1")
    await Effect.runPromise(Effect.gen(function*() {
      expect((yield* ModelLock).models[0]?.model_id).toBe("gpt")
      expect((yield* inferenceClient).resolve()).toMatchObject({ contextWindowTokens: 32000 })
    }).pipe(Effect.provide(services.layers)))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
