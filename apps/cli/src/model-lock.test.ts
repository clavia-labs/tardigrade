import { modelCatalogForConfig, modelConfigDigest } from "@clavia/tardigrade-model/lock"
import { modelCatalogOf } from "@clavia/tardigrade-model/registry"
import { Effect } from "effect"
import { resolveModelLock as resolveLock } from "@clavia/tardigrade-model/resolution"
import { layerCliModelRegistry } from "./model-registry"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ModelConfig } from "@clavia/tardigrade-server/config"

import {
  readModelLock,
  writeModelLock
} from "./model-lock"

const resolveModelLock = (config: ModelConfig, options: Parameters<typeof layerCliModelRegistry>[0]) =>
  Effect.runPromise(resolveLock(config).pipe(Effect.provide(layerCliModelRegistry(options))))

const source = {
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: {
      gpt: { id: "gpt", limit: { context: 128_000, output: 16_000 } },
      hidden: { id: "hidden", limit: { context: 64_000, output: 8_000 } }
    }
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      claude: { id: "claude", limit: { context: 200_000, output: 32_000 } }
    }
  }
}

const config: ModelConfig = {
  default: { provider: "openai", model_id: "gpt" },
  allow: [{ provider: "openai", model_ids: ["gpt"] }],
  providers: {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      protocol: "openai-responses",
      env: ["OPENAI_API_KEY"]
    }
  }
}

let root = ""
afterEach(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true })
})

describe("model lock", () => {
  test("resolves only the deployment model scope", async () => {
    root = await mkdtemp(join(process.cwd(), ".tdg-model-lock-test-"))
    const lock = await resolveModelLock(config, {
      sourceUrl: "https://models.dev/api.json",
      cachePath: join(root, "cache.json"),
      timeoutMillis: 1_000,
      fetch: (async () => Response.json(source, { headers: { etag: "catalog-7" } })) as unknown as typeof fetch
    })

    expect(lock).toMatchObject({
      schema: 1,
      catalog: {
        revision: "catalog-7",
        providers: [{ id: "openai", models: [{ id: "gpt" }] }]
      }
    })
    expect(lock.catalog.providers[0]?.models).toHaveLength(1)
    expect(lock.configDigest).toBe(await modelConfigDigest(config))
  })

  test("persists the lock and detects changed configuration", async () => {
    root = await mkdtemp(join(process.cwd(), ".tdg-model-lock-test-"))
    const lock = {
      schema: 1 as const,
      configDigest: await modelConfigDigest(config),
      catalog: modelCatalogOf(source, "catalog-7", 1)
    }
    await writeModelLock(root, lock)

    expect(await readModelLock(root)).toEqual(lock)
    expect(await modelCatalogForConfig(config, lock)).toEqual(lock.catalog)
    await expect(modelCatalogForConfig({ ...config, allow: "*" }, lock)).rejects.toThrow("does not match")
  })
})

const localConfig: ModelConfig = {
  allow: "*",
  default: { provider: "localhost", model_id: "qwen-local" },
  providers: {
    localhost: {
      protocol: "openai-chat-completions",
      baseUrl: "http://localhost:8080/v1",
      env: ["API_KEY"],
      models: { "qwen-local": { metadata: { contextWindowTokens: 32768, maxOutputTokens: 4096, toolCall: true } } }
    }
  }
}

const offlineOptions = () => ({
  sourceUrl: "https://registry.invalid/models.json",
  cachePath: join(root, "registry.json"),
  timeoutMillis: 100,
  fetch: (() => { throw new Error("registry must not be contacted") }) as unknown as typeof fetch
})

test("custom models resolve and regenerate without registry access", async () => {
  root = await mkdtemp(join(process.cwd(), ".tdg-model-lock-test-"))
  const lock = await resolveModelLock(localConfig, offlineOptions())
  expect(lock.catalog).toMatchObject({ source: "custom", providers: [{
    id: "localhost", models: [{ id: "qwen-local", metadata: { contextWindowTokens: 32768, maxOutputTokens: 4096, toolCall: true } }]
  }] })
  expect(await resolveModelLock(localConfig, offlineOptions())).toEqual(lock)
  await writeModelLock(root, lock)
  expect(await readModelLock(root)).toEqual(lock)
})

test("custom metadata overrides registry fields before policy filters the lock", async () => {
  root = await mkdtemp(join(process.cwd(), ".tdg-model-lock-test-"))
  const overrides: ModelConfig = { ...config, providers: { openai: {
    ...config.providers.openai!, protocol: "openai-responses", models: { gpt: { metadata: { maxOutputTokens: 2048, toolCall: false } } }
  } } }
  const lock = await resolveModelLock(overrides, { ...offlineOptions(), fetch: (async () => Response.json(source)) as unknown as typeof fetch })
  expect(lock.catalog.source).toBe("mixed")
  expect(lock.catalog.providers[0]?.models).toEqual([{ id: "gpt", metadata: { contextWindowTokens: 128000, maxOutputTokens: 2048, toolCall: false } }])
})

test("invalid custom metadata fails before a registry request", async () => {
  root = await mkdtemp(join(process.cwd(), ".tdg-model-lock-test-"))
  for (const contextWindowTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid: ModelConfig = { ...localConfig, providers: { localhost: {
      ...localConfig.providers.localhost!, protocol: "openai-chat-completions", models: { "qwen-local": { metadata: { contextWindowTokens } } }
    } } }
    await expect(resolveModelLock(invalid, offlineOptions())).rejects.toThrow()
  }
})

test("an unlisted model needs an explicit context window", async () => {
  root = await mkdtemp(join(process.cwd(), ".tdg-model-lock-test-"))
  const incomplete: ModelConfig = { ...localConfig, providers: { localhost: {
    ...localConfig.providers.localhost!, protocol: "openai-chat-completions", models: { "qwen-local": { metadata: { toolCall: true } } }
  } } }
  await expect(resolveModelLock(incomplete, { ...offlineOptions(), fetch: (async () => Response.json(source)) as unknown as typeof fetch })).rejects.toThrow("must declare contextWindowTokens")
})

test("explicit model references still resolve from the registry beside custom entries", async () => {
  root = await mkdtemp(join(process.cwd(), ".tdg-model-lock-test-"))
  const mixed: ModelConfig = {
    default: { provider: "openai", model_id: "gpt" },
    allow: [{ provider: "openai", model_ids: ["gpt", "custom", "hidden"] }],
    providers: { openai: {
      ...config.providers.openai!, protocol: "openai-responses", models: { custom: { metadata: { contextWindowTokens: 32000 } } }
    } }
  }
  const options = { ...offlineOptions(), fetch: (async () => Response.json(source)) as unknown as typeof fetch }
  for (const selected of ["gpt", "custom"]) {
    const lock = await resolveModelLock({ ...mixed, default: { provider: "openai", model_id: selected } }, options)
    expect(lock.catalog.source).toBe("mixed")
    expect(lock.catalog.providers[0]?.models.map((model) => model.id).sort()).toEqual(["custom", "gpt", "hidden"])
  }
})
