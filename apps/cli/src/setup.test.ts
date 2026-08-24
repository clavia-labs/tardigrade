import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BunFileSystem } from "@effect/platform-bun"

import {
  CONFIG_MODE,
  envPathIn,
  modelsDevAt,
  PRESETS,
  readSetupEnv,
  setupJson,
  setupSummary,
  writeSetup,
  type SetupAnswers
} from "./setup"

// `tdg setup` against a home directory this file owns. The prompts are the one part a test cannot
// drive, so the module splits at the answers: everything after them is a value, and the key's whole
// journey from answer to file is checked here.

const KEY = "sk-do-not-print-me"

const answers: SetupAnswers = {
  provider: "openai",
  baseUrl: "https://api.example.com/v1",
  model_id: "a-model",
  credential: KEY,
  driver: "openai-responses",
  env: ["OPENAI_API_KEY"]
}

let root = ""

const write = (given: SetupAnswers = answers) =>
  Effect.runPromise(Effect.orDie(Effect.provide(writeSetup(root, given), BunFileSystem.layer)))

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tdg-project-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("the presets", () => {
  // Every entry is a URL this repository promises to keep correct, so the list stays short and each
  // prefill is an absolute https origin (setup.ts, PRESETS).
  test("each preset either prefills an https base URL or asks for one", () => {
    for (const preset of PRESETS) {
      if (preset.baseUrl !== undefined) expect(preset.baseUrl.startsWith("https://")).toBe(true)
      expect(preset.title.length).toBeGreaterThan(0)
    }
    expect(PRESETS.find((preset) => preset.title === "Vercel AI Gateway")?.baseUrl).toBe("https://ai-gateway.vercel.sh/v1")
    expect(PRESETS.find((preset) => preset.title === "Cloudflare AI Gateway")?.baseUrl).toBeUndefined()
    expect(PRESETS.find((preset) => preset.title === "OpenRouter")?.modelExample).toContain("/")
    expect(PRESETS.find((preset) => preset.title === "OpenRouter")?.credential).toBe("OpenRouter API key")
    expect(PRESETS.some((preset) => preset.provider === "amazon-bedrock")).toBe(true)
    expect(PRESETS.some((preset) => preset.title === "Microsoft Foundry")).toBe(true)
    expect(PRESETS.some((preset) => preset.title === "Google AI")).toBe(true)
    expect(PRESETS.some((preset) => preset.title === "Google Vertex AI")).toBe(true)
    expect(PRESETS.some((preset) => preset.baseUrl === undefined && preset.provider === undefined)).toBe(true)
  })
})

describe("model discovery", () => {
  test("models.dev supplies provider metadata with its revision", async () => {
    const fetcher = (async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => Response.json({
      openrouter: {
        id: "openrouter",
        env: ["OPENROUTER_API_KEY"],
        models: {
          "anthropic/claude": { id: "anthropic/claude", limit: { context: 200_000, output: 32_000 } }
        }
      }
    }, { headers: { etag: "catalog-7" } })) as typeof fetch
    expect(await modelsDevAt("openrouter", { fetch: fetcher })).toMatchObject({
      revision: "catalog-7",
      env: ["OPENROUTER_API_KEY"],
      models: [{ id: "anthropic/claude" }]
    })
  })
})

describe("writeSetup", () => {
  test("the project environment is written at 0600", async () => {
    const path = await write()
    expect(path).toBe(envPathIn(root))
    const file = await stat(path)
    expect(file.mode & 0o777).toBe(CONFIG_MODE)
  })

  test("configuration and the credential use separate entries", async () => {
    await write()
    const held = await Effect.runPromise(Effect.provide(readSetupEnv(root), BunFileSystem.layer))
    expect(JSON.parse(held.TARDIGRADE_MODELS!)).toEqual({
      default: { provider: "openai", model_id: "a-model" },
      providers: {
        openai: {
          baseUrl: "https://api.example.com/v1",
          driver: "openai-responses",
          env: ["OPENAI_API_KEY"]
        }
      }
    })
    expect(held.OPENAI_API_KEY).toBe(KEY)
    expect(held.TARDIGRADE_MODELS).not.toContain(KEY)
  })

  test("unrelated environment lines are kept", async () => {
    await writeFile(envPathIn(root), "# application\nAPP_NAME=release\n")
    await write()
    const raw = await readFile(envPathIn(root), "utf8")
    expect(raw).toContain("# application\nAPP_NAME=release\n")
  })

  test("a later setup keeps prior providers and changes the default", async () => {
    await write()
    await write({
      ...answers,
      provider: "openrouter",
      model_id: "another-model",
      baseUrl: "https://secondary.example.com/v1",
      credential: "secondary-key",
      env: ["OPENROUTER_API_KEY"]
    })
    const held = await Effect.runPromise(Effect.provide(readSetupEnv(root), BunFileSystem.layer))
    const model = JSON.parse(held.TARDIGRADE_MODELS!) as { default: unknown; providers: Record<string, { baseUrl: string }> }
    expect(Object.keys(model.providers).sort()).toEqual(["openai", "openrouter"])
    expect(model.default).toEqual({ provider: "openrouter", model_id: "another-model" })
    expect(model.providers.openai?.baseUrl).toBe("https://api.example.com/v1")
    expect(model.providers.openrouter?.baseUrl).toBe("https://secondary.example.com/v1")
    expect(held.OPENAI_API_KEY).toBe(KEY)
    expect(held.OPENROUTER_API_KEY).toBe("secondary-key")
  })

  // A rerun over a file left readable by everyone must narrow it, and `mode` on a write applies
  // only when the file is created, so the mode is set again afterwards.
  test("a rerun narrows a file that was left wide open", async () => {
    await writeFile(envPathIn(root), "APP_NAME=release\n")
    await chmod(envPathIn(root), 0o644)
    const path = await write()
    expect((await stat(path)).mode & 0o777).toBe(CONFIG_MODE)
  })

  test("an invalid existing model entry is kept and reported", async () => {
    await writeFile(envPathIn(root), 'TARDIGRADE_MODELS="bad"\nAPP_NAME=release\n')
    await expect(write()).rejects.toThrow("existing TARDIGRADE_MODELS is invalid")
    expect(await readFile(envPathIn(root), "utf8")).toContain("APP_NAME=release")
  })
})

describe("what setup prints", () => {
  // The key is the one value that is written and never shown. Neither rendering may carry it, and
  // neither may the path line, so there is nothing to scrub from a shared terminal.
  test("the key is never echoed, in either rendering", async () => {
    const path = await write()
    const summary = setupSummary(path, answers)
    expect(summary).not.toContain(KEY)
    expect(summary).toContain(path)
    expect(summary).toContain("a-model")
    expect(summary).not.toContain("key")
    const json = setupJson(path, answers)
    expect(JSON.stringify(json)).not.toContain(KEY)
    expect(json.credential).toBe("stored")
    expect(json.provider).toBe("openai")
    expect(json.driver).toBe("openai-responses")
    expect(summary).toContain("default a-model")
  })
})
