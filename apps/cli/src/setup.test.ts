import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, readFile, writeFile, mkdir, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BunFileSystem } from "@effect/platform-bun"

import { configPathIn, parseFileConfig, readFileConfig } from "./config"
import {
  CONFIG_DIR_MODE,
  CONFIG_MODE,
  homeOf,
  modelsDevAt,
  PRESETS,
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
  apiKey: KEY,
  driver: "openai-responses"
}

let home = ""

const write = (given: SetupAnswers = answers) =>
  Effect.runPromise(Effect.orDie(Effect.provide(writeSetup(home, given), BunFileSystem.layer)))

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tdg-home-"))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
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
        models: {
          "anthropic/claude": { id: "anthropic/claude", limit: { context: 200_000, output: 32_000 } }
        }
      }
    }, { headers: { etag: "catalog-7" } })) as typeof fetch
    expect(await modelsDevAt("openrouter", { fetch: fetcher })).toMatchObject({
      revision: "catalog-7",
      models: [{ id: "anthropic/claude" }]
    })
  })
})

describe("writeSetup", () => {
  test("the file is written where every command reads it, at 0600", async () => {
    const path = await write()
    expect(path).toBe(configPathIn(home))
    const file = await stat(path)
    expect(file.mode & 0o777).toBe(CONFIG_MODE)
    const directory = await stat(join(home, ".tardigrade"))
    expect(directory.mode & 0o777).toBe(CONFIG_DIR_MODE)
  })

  test("the answers land as one provider and an exact default coordinate", async () => {
    const path = await write()
    const held = parseFileConfig(await readFile(path, "utf8"))
    expect(held.model).toEqual({
      default: { provider: "openai", model_id: "a-model" },
      providers: {
        openai: {
          baseUrl: "https://api.example.com/v1",
          apiKey: KEY,
          driver: "openai-responses"
        }
      }
    })
  })

  // The command owns the model block and nothing else, so a remote a person wrote by hand survives
  // a second run (setup.ts, writeSetup).
  test("a value the file already held is kept", async () => {
    await mkdir(join(home, ".tardigrade"), { recursive: true })
    await writeFile(configPathIn(home), JSON.stringify({ url: "https://agents.example.com", token: "held" }))
    const path = await write()
    const held = parseFileConfig(await readFile(path, "utf8"))
    expect(held.url).toBe("https://agents.example.com")
    expect(held.token).toBe("held")
    expect(held.model?.default).toEqual({ provider: "openai", model_id: "a-model" })
  })

  test("a later setup keeps prior providers and changes the default", async () => {
    await write()
    const path = await write({
      ...answers,
      provider: "openrouter",
      model_id: "another-model",
      baseUrl: "https://secondary.example.com/v1",
      apiKey: "secondary-key"
    })
    const held = parseFileConfig(await readFile(path, "utf8"))
    expect(Object.keys(held.model?.providers ?? {}).sort()).toEqual(["openai", "openrouter"])
    expect(held.model?.default).toEqual({ provider: "openrouter", model_id: "another-model" })
    expect(held.model?.providers?.openai?.baseUrl).toBe("https://api.example.com/v1")
    expect(held.model?.providers?.openrouter?.baseUrl).toBe("https://secondary.example.com/v1")
  })

  // A rerun over a file left readable by everyone must narrow it, and `mode` on a write applies
  // only when the file is created, so the mode is set again afterwards.
  test("a rerun narrows a file that was left wide open", async () => {
    await mkdir(join(home, ".tardigrade"), { recursive: true })
    await writeFile(configPathIn(home), "{}")
    await chmod(configPathIn(home), 0o644)
    const path = await write()
    expect((await stat(path)).mode & 0o777).toBe(CONFIG_MODE)
  })

  test("the file the command wrote is the file the resolver reads", async () => {
    await write()
    const file = await Effect.runPromise(Effect.provide(readFileConfig({ HOME: home }), BunFileSystem.layer))
    expect(file.model).toEqual({
      default: { provider: "openai", model_id: "a-model" },
      providers: {
        openai: {
          baseUrl: "https://api.example.com/v1",
          apiKey: KEY,
          driver: "openai-responses"
        }
      }
    })
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
    expect(json.apiKey).toBe("stored")
    expect(json.provider).toBe("openai")
    expect(json.driver).toBe("openai-responses")
    expect(summary).toContain("default a-model")
  })
})

describe("homeOf", () => {
  test("an unset or blank HOME is no home at all", () => {
    expect(homeOf({})).toBeUndefined()
    expect(homeOf({ HOME: "  " })).toBeUndefined()
    expect(homeOf({ HOME: "/home/someone" })).toBe("/home/someone")
  })
})
