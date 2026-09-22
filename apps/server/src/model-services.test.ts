import { canonicalModelConfig, modelConfigOf } from "@clavia/tardigrade-model/config"
import { sha256Of } from "@clavia/tardigrade-model/digest"
import { ModelLock } from "@clavia/tardigrade-model/lock"
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

test("Bun model services use locked definitions through startup and restart without registry access", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected registry access"))
  const directory = await mkdtemp(join(tmpdir(), "model-services-"))
  try {
    const configFile = join(directory, "wrangler.jsonc")
    await writeFile(configFile, JSON.stringify({ vars: { TARDIGRADE_CONFIG: { models: {
      allow: "*",
      providers: { openai: { protocol: "openai-responses", baseUrl: "https://example.test/v1", env: ["OLD_MANIFEST_KEY"] } },
      default: { provider: "openai", model_id: "gpt" }
    } } } }))
    await writeFile(join(directory, "models.lock.json"), JSON.stringify({ schema: 2,
      providers: { openai: { protocol: "openai-responses", baseUrl: "https://locked.test/v1", env: ["TEST_MODEL_KEY"] } },
      models: [{ provider: "openai", model_id: "gpt", contextWindowTokens: 128000, maxOutputTokens: 16000 }]
    }))
    const services = await bunModelServices({
      configFile: pathToFileURL(configFile),
      model: { providerLayer: (options) => {
        expect(options.model.config).toMatchObject({ max_output_tokens: 1234 })
        return providerLayer(options)
      }, configure: (selected) => {
        expect(selected.model_id).toBe("gpt")
        return { maxOutputTokens: 1234, timeout: { idleMs: 12345 } }
      } },
      env: { PORT: "4321", TEST_MODEL_KEY: "test-secret", TARDIGRADE_MODEL_CATALOG_CACHE: join(directory, "catalog.json") }
    })
    expect(services.config.modelCredentials).toEqual({ TEST_MODEL_KEY: "test-secret" })
    expect(services.config.port).toBe(4321)
    expect(services.config.model.providers.openai?.baseUrl).toBe("https://locked.test/v1")
    const catalog = await Effect.runPromise(services.api.catalog.read)
    expect(catalog.policy.default).toEqual({ provider: "openai", model_id: "gpt" })
    expect(catalog.snapshot?.providers[0]?.models[0]?.id).toBe("gpt")
    expect(Object.keys(catalog.snapshot!).sort()).toEqual(["providers", "revision"])
    expect(JSON.stringify(catalog)).not.toContain("test-secret")
    await writeFile(configFile, JSON.stringify({ vars: { TARDIGRADE_CONFIG: { models: { allow: "*", default: { provider: "openai", model_id: "gpt" } } } } }))
    const restarted = await bunModelServices({ configFile: pathToFileURL(configFile), env: { TEST_MODEL_KEY: "test-secret" } })
    expect(await Effect.runPromise(restarted.api.catalog.read)).toEqual(catalog)
    expect(fetch).not.toHaveBeenCalled()
    await Effect.runPromise(Effect.gen(function*() {
      const lock = yield* ModelLock
      expect(lock.resolve()).toMatchObject({ model: { provider: "openai", model_id: "gpt" }, contextWindowTokens: 128000 })
      expect(lock.definitions.models).toContainEqual(expect.objectContaining({ provider: "openai", model_id: "gpt", maxOutputTokens: 16000 }))
      const selection = yield* ModelSelection
      const settings = yield* selection.settings!()
      expect(settings.policy).toMatchObject({ maxOutputTokens: 1234, timeout: { idleMs: 12345 } })
      yield* FileSystem.FileSystem
      yield* Path.Path
      yield* HttpClient.HttpClient
    }).pipe(Effect.provide(services.layers)))
  } finally {
    fetch.mockRestore()
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

test("Bun model services reject missing and malformed locks beside the configured manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-lock-services-"))
  try {
    const configFile = join(directory, "custom.jsonc")
    await writeFile(configFile, JSON.stringify({ vars: { TARDIGRADE_CONFIG: { models: { allow: "*", default: { provider: "custom", model_id: "model" } } } } }))
    await expect(bunModelServices({ configFile, env: {} })).rejects.toThrow("models.lock.json is missing")
    await writeFile(join(directory, "models.lock.json"), JSON.stringify({ schema: 2, providers: {}, models: [{ provider: "custom", model_id: "model", contextWindowTokens: 0 }] }))
    await expect(bunModelServices({ configFile, env: {} })).rejects.toThrow("contextWindowTokens")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Bun upcasts a legacy lock at startup without changing the saved file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-lock-v1-"))
  try {
    const models = modelConfigOf({ allow: "*", default: { provider: "custom", model_id: "small" }, providers: {
      custom: { protocol: "openai-chat-completions", baseUrl: "https://custom.test/v1", env: ["CUSTOM_KEY"] }
    } })
    const configFile = join(directory, "wrangler.jsonc")
    await writeFile(configFile, JSON.stringify({ vars: { TARDIGRADE_CONFIG: { models } } }))
    const legacy = { schema: 1, configDigest: await sha256Of(canonicalModelConfig(models)), catalog: {
      source: "custom", revision: "saved", refreshedAt: 1, status: "cached",
      providers: [{ id: "custom", name: "Custom", env: [], models: [{ id: "small", metadata: { contextWindowTokens: 32000 } }] }]
    } }
    const path = join(directory, "models.lock.json")
    await writeFile(path, JSON.stringify(legacy))
    const services = await bunModelServices({ configFile, env: { CUSTOM_KEY: "fixture" } })
    const lock = await Effect.runPromise(ModelLock.pipe(Effect.provide(services.layers)))
    expect(lock.definitions.schema).toBe(2)
    expect(lock.resolve().contextWindowTokens).toBe(32000)
    expect(services.config.model.providers.custom?.baseUrl).toBe("https://custom.test/v1")
    expect(await Bun.file(path).json()).toEqual(legacy)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
