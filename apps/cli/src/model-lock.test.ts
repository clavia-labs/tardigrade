import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ModelConfig } from "@clavia/tardigrade-server/config"

import {
  assertModelLockCurrent,
  modelConfigDigest,
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
    expect(lock.configDigest).toBe(modelConfigDigest(config))
  })

  test("persists the lock and detects changed configuration", async () => {
    root = await mkdtemp(join(process.cwd(), ".tdg-model-lock-test-"))
    const lock = {
      schema: 1 as const,
      configDigest: modelConfigDigest(config),
      catalog: {
        source: "models.dev" as const,
        revision: "catalog-7",
        refreshedAt: 1,
        status: "cached" as const,
        providers: []
      }
    }
    await writeModelLock(root, lock)

    expect(await readModelLock(root)).toEqual(lock)
    expect(() => assertModelLockCurrent(config, lock)).not.toThrow()
    expect(() => assertModelLockCurrent({ ...config, allow: "*" }, lock)).toThrow("does not match")
  })
})
