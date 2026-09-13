import { inferenceClient } from "@clavia/tardigrade-agent/testing/inference"
import { expect, test } from "bun:test"
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
      providers: { openai: { protocol: "openai-responses", baseUrl: "https://example.test/v1", env: ["TEST_MODEL_KEY"] } },
      default: { provider: "openai", model_id: "gpt" }
    } } } }))
    let fetched = 0
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
      catalog: { fetch: (async () => {
        fetched += 1
        return Response.json({ openai: { id: "openai", name: "OpenAI", models: {
          gpt: { id: "gpt", name: "GPT", limit: { context: 128000, output: 16000 } }
        } } })
      }) as unknown as typeof fetch }
    })
    expect(services.config.port).toBe(4321)
    expect(fetched).toBe(1)
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
