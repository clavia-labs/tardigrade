import { modelLockService, parseModelLock } from "@clavia/tardigrade-model/lock"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelConfig } from "@clavia/tardigrade-server/config"

import {
  readModelLock,
  resolveModelLock,
  writeModelLock
} from "./model-lock"

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
    root = await mkdtemp(join(tmpdir(), "tdg-model-lock-test-"))
    const lock = await resolveModelLock(config, {
      sourceUrl: "https://models.dev/api.json",
      cachePath: join(root, "cache.json"),
      timeoutMillis: 1_000,
      fetch: (async () => Response.json(source, { headers: { etag: "catalog-7" } })) as unknown as typeof fetch
    })

    expect(lock).toMatchObject({ schema: 2, providers: config.providers, models: [{
      provider: "openai", model_id: "gpt", contextWindowTokens: 128000, source: "https://models.dev/api.json"
    }] })
    expect(lock.models).toHaveLength(1)
    expect(modelLockService(lock, config).resolve().model).toEqual(config.default!)

  })

  test("persists the shared schema and rejects invalid definitions", async () => {
    root = await mkdtemp(join(tmpdir(), "tdg-model-lock-test-"))
    const lock = { schema: 2 as const, providers: config.providers, models: [{ provider: "openai", model_id: "gpt", contextWindowTokens: 128000 }] }
    await writeModelLock(root, lock)
    expect(await readModelLock(root)).toEqual(lock)
    expect(parseModelLock(JSON.stringify(lock))).toEqual(lock)
    await expect(writeModelLock(root, { ...lock, models: [{ ...lock.models[0]!, contextWindowTokens: 0 }] })).rejects.toThrow("contextWindowTokens")
    expect(await readModelLock(root)).toEqual(lock)
  })
})


test("locks and reloads custom metadata without a registry", async () => {
  root = await mkdtemp(join(tmpdir(), "tdg-model-lock-test-"))
  const custom: ModelConfig = {
    allow: "*", default: { provider: "localhost", model_id: "local" },
    providers: { localhost: {
      protocol: "openai-chat-completions", baseUrl: "http://localhost:8080/v1", env: ["API_KEY"],
      models: { local: { metadata: { contextWindowTokens: 32768, toolCall: true }, options: { temperature: 0.2 } } }
    } }
  }
  let requests = 0
  const lock = await resolveModelLock(custom, {
    sourceUrl: "https://example.com/catalog", cachePath: join(root, "cache.json"), timeoutMillis: 1000,
    fetch: (async () => { requests++; throw new Error("registry must not be contacted") }) as unknown as typeof fetch
  })
  expect(requests).toBe(0)
  expect(await resolveModelLock(custom)).toEqual(lock)
  expect(lock).toMatchObject({ schema: 2, models: [{ provider: "localhost", model_id: "local", contextWindowTokens: 32768, toolCall: true, options: { temperature: 0.2 } }] })
  expect(lock.models[0]).not.toHaveProperty("source")
  await writeModelLock(root, lock)
  expect(await readModelLock(root)).toEqual(lock)
  expect(modelLockService(lock, custom).resolve().model).toEqual(custom.default!)
})
