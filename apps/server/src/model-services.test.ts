import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Infer } from "@clavia/tardigrade-agent"
import { modelAdapters } from "@clavia/tardigrade-model/adapter"
import { openAICompatibleAdapter } from "@clavia/tardigrade-model/openai"
import { bunModelServices } from "./model-services"

const adapters = modelAdapters(openAICompatibleAdapter)

test("Bun model services resolve configuration, expose catalog policy, and supply host services", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-services-"))
  try {
    const configFile = join(directory, "wrangler.jsonc")
    await writeFile(configFile, JSON.stringify({ vars: { TARDIGRADE_CONFIG: { models: {
      allow: "*",
      providers: { openai: { protocol: "openai-chat-completions", baseUrl: "https://example.test/v1", env: ["TEST_MODEL_KEY"] } },
      default: { provider: "openai", model_id: "gpt" }
    } } } }))
    let fetched = 0
    const services = await bunModelServices({
      configFile: pathToFileURL(configFile),
      env: { PORT: "4321", TEST_MODEL_KEY: "test-secret", TARDIGRADE_MODEL_CATALOG_CACHE: join(directory, "catalog.json") },
      adapters,
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
      yield* Infer
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
      await expect(bunModelServices({ ...source, adapters })).rejects.toThrow("does not exist")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
