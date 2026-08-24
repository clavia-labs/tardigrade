import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BunFileSystem } from "@effect/platform-bun"

import { parseProjectConfig, projectConfigPathIn } from "./config"
import {
  envPathIn,
  modelsDevAt,
  PRESETS,
  readSetupEnv,
  SECRETS_MODE,
  setupAnswersFrom,
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

describe("declarative setup", () => {
  const flags = {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    driver: "openai-chat-completions",
    credentialEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4-6"
  }

  test("all flags resolve the credential by environment name", () => {
    expect(setupAnswersFrom(flags, { OPENROUTER_API_KEY: KEY })).toEqual({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      driver: "openai-chat-completions",
      env: ["OPENROUTER_API_KEY"],
      model_id: "anthropic/claude-sonnet-4-6",
      credential: KEY
    })
  })

  test("no flags leaves setup interactive", () => {
    expect(setupAnswersFrom({}, {})).toBeUndefined()
  })

  test("partial flags name every missing value", () => {
    expect(() => setupAnswersFrom({ provider: "openrouter" }, {}))
      .toThrow("--base-url, --driver, --credential-env, --default-model")
  })

  test("the named credential must already be injected", () => {
    expect(() => setupAnswersFrom(flags, {})).toThrow("OPENROUTER_API_KEY is not set")
  })
})

describe("writeSetup", () => {
  test("the project config and private environment are written separately", async () => {
    const files = await write()
    expect(files).toEqual({
      configPath: projectConfigPathIn(root),
      secretsPath: envPathIn(root)
    })
    expect((await stat(files.secretsPath)).mode & 0o777).toBe(SECRETS_MODE)
  })

  test("configuration is JSONC and the credential is the only environment entry", async () => {
    await write()
    const project = parseProjectConfig(await readFile(projectConfigPathIn(root), "utf8"))
    expect(project.models).toEqual({
      default: { provider: "openai", model_id: "a-model" },
      providers: {
        openai: {
          baseUrl: "https://api.example.com/v1",
          driver: "openai-responses",
          env: ["OPENAI_API_KEY"]
        }
      }
    })
    const held = await Effect.runPromise(Effect.provide(readSetupEnv(root), BunFileSystem.layer))
    expect(held.OPENAI_API_KEY).toBe(KEY)
    expect(Object.keys(held)).toEqual(["OPENAI_API_KEY"])
    expect(await readFile(projectConfigPathIn(root), "utf8")).not.toContain(KEY)
  })

  test("unrelated environment lines and JSONC comments are kept", async () => {
    await writeFile(envPathIn(root), "# application\nAPP_NAME=release\n")
    await writeFile(projectConfigPathIn(root), "{\n  // Keep this setting.\n  \"later\": true\n}\n")
    await write()
    expect(await readFile(envPathIn(root), "utf8")).toContain("# application\nAPP_NAME=release\n")
    const config = await readFile(projectConfigPathIn(root), "utf8")
    expect(config).toContain("// Keep this setting.")
    expect(config).toContain('"later": true')
  })

  test("a later setup keeps prior providers and changes the default", async () => {
    await write()
    const first = await readFile(projectConfigPathIn(root), "utf8")
    await writeFile(
      projectConfigPathIn(root),
      first.replace('"openai": {', '"openai": {\n          // Keep this provider note.')
    )
    await write({
      ...answers,
      provider: "openrouter",
      model_id: "another-model",
      baseUrl: "https://secondary.example.com/v1",
      credential: "secondary-key",
      env: ["OPENROUTER_API_KEY"]
    })
    const held = await Effect.runPromise(Effect.provide(readSetupEnv(root), BunFileSystem.layer))
    const model = parseProjectConfig(await readFile(projectConfigPathIn(root), "utf8")).models
    expect(Object.keys(model.providers).sort()).toEqual(["openai", "openrouter"])
    expect(model.default).toEqual({ provider: "openrouter", model_id: "another-model" })
    expect(model.providers.openai?.baseUrl).toBe("https://api.example.com/v1")
    expect(model.providers.openrouter?.baseUrl).toBe("https://secondary.example.com/v1")
    expect(await readFile(projectConfigPathIn(root), "utf8")).toContain("// Keep this provider note.")
    expect(held.OPENAI_API_KEY).toBe(KEY)
    expect(held.OPENROUTER_API_KEY).toBe("secondary-key")
  })

  // A rerun over a file left readable by everyone must narrow it, and `mode` on a write applies
  // only when the file is created, so the mode is set again afterwards.
  test("a rerun narrows a file that was left wide open", async () => {
    await writeFile(envPathIn(root), "APP_NAME=release\n")
    await chmod(envPathIn(root), 0o644)
    const files = await write()
    expect((await stat(files.secretsPath)).mode & 0o777).toBe(SECRETS_MODE)
  })

  test("invalid JSONC is kept and reported", async () => {
    await writeFile(projectConfigPathIn(root), "{ broken")
    await expect(write()).rejects.toThrow("invalid JSONC")
    expect(await readFile(projectConfigPathIn(root), "utf8")).toBe("{ broken")
  })
})

describe("what setup prints", () => {
  // The key is the one value that is written and never shown. Neither rendering may carry it, and
  // neither may the path line, so there is nothing to scrub from a shared terminal.
  test("the key is never echoed, in either rendering", async () => {
    const files = await write()
    const summary = setupSummary(files, answers)
    expect(summary).not.toContain(KEY)
    expect(summary).toContain(files.configPath)
    expect(summary).toContain(files.secretsPath)
    expect(summary).toContain("a-model")
    expect(summary).not.toContain("key")
    const json = setupJson(files, answers)
    expect(JSON.stringify(json)).not.toContain(KEY)
    expect(json.credential).toBe("stored")
    expect(json.provider).toBe("openai")
    expect(json.driver).toBe("openai-responses")
    expect(summary).toContain("default a-model")
  })
})
