import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { parse } from "jsonc-parser"
import { BunFileSystem } from "@effect/platform-bun"

import { parseProjectConfig, projectConfigPathIn } from "./config"
import { CELLD_PROJECT_CONFIG_PATH } from "./celld"
import {
  defaultModelFrom,
  envPathIn,
  gitignorePathIn,
  modelsDevAt,
  PRESETS,
  providerAnswersFrom,
  readSetupEnv,
  runtimeEnvironmentOf,
  SECRETS_MODE,
  setupAnswersFrom,
  setupJson,
  setupPlanSummary,
  setupSummary,
  writeDefaultSetup,
  writeProviderSetup,
  writeSetup,
  writeSetupPlan,
  type ProviderAnswers,
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
  protocol: "openai-responses",
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
  const fetcher = (async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => Response.json({
    openrouter: {
      id: "openrouter",
      env: ["OPENROUTER_API_KEY"],
      models: {
        agent: { id: "agent", tool_call: true, modalities: { output: ["text"] } },
        image: { id: "image", tool_call: true, modalities: { output: ["image"] } },
        "no-tools": { id: "no-tools", tool_call: false, modalities: { output: ["text"] } },
        unknown: { id: "unknown", limit: { context: 200_000, output: 32_000 } }
      }
    }
  }, { headers: { etag: "catalog-7" } })) as typeof fetch

  test("models.dev supplies compatible provider models with its revision", async () => {
    expect(await modelsDevAt("openrouter", { fetch: fetcher })).toMatchObject({
      revision: "catalog-7",
      env: ["OPENROUTER_API_KEY"],
      models: [{ id: "agent" }, { id: "unknown" }]
    })
  })

  test("a caller can replace the visible selection policy", async () => {
    const found = await modelsDevAt("openrouter", {
      fetch: fetcher,
      selectionPolicy: { outputModality: "image", requireToolCalls: false }
    })

    expect(found.models.map((model) => model.id)).toEqual(["image", "unknown"])
  })

  test("a project cache prevents a second catalog fetch", async () => {
    const cachePath = join(root, ".tardigrade", "models.json")
    const fresh = await modelsDevAt("openrouter", { cachePath, fetch: fetcher })
    const refused = (async () => { throw new Error("source should not be called") }) as unknown as typeof fetch
    const cached = await modelsDevAt("openrouter", { cachePath, fetch: refused })

    expect(fresh.status).toBe("fresh")
    expect(cached.status).toBe("cached")
    expect(cached.models).toEqual(fresh.models)
  })
})

describe("declarative setup", () => {
  const flags = {
    provider: "openrouter",
    providerConfig: '{"env":["OPENROUTER_API_KEY"]}',
    defaultModel: "anthropic/claude-sonnet-4-6"
  }

  test("provider JSON and a default model resolve initialization", () => {
    expect(setupAnswersFrom(flags)).toEqual({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      protocol: "openai-chat-completions",
      env: ["OPENROUTER_API_KEY"],
      model_id: "anthropic/claude-sonnet-4-6"
    })
  })

  test("no options leave setup interactive", () => {
    expect(setupAnswersFrom({})).toBeUndefined()
  })

  test("partial options name every missing value", () => {
    expect(() => setupAnswersFrom({ provider: "openrouter" }))
      .toThrow("--provider-config, --default-model")
  })

  test("declarative initialization does not read the secret", () => {
    expect(JSON.stringify(setupAnswersFrom(flags))).not.toContain(KEY)
  })

  test("provider and default flags resolve independently", () => {
    expect(providerAnswersFrom({
      provider: flags.provider,
      config: '{"env":["OPENROUTER_API_KEY"]}'
    })).toEqual({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      protocol: "openai-chat-completions",
      env: ["OPENROUTER_API_KEY"]
    })
    expect(defaultModelFrom({ provider: "openrouter", model: flags.defaultModel })).toEqual({
      provider: "openrouter",
      model_id: "anthropic/claude-sonnet-4-6"
    })
  })

  test("provider JSON validates fields that depend on the protocol", () => {
    expect(providerAnswersFrom({
      provider: "amazon-bedrock",
      config: '{"baseUrl":"https://gateway.example.com/bedrock","region":"ap-southeast-1","env":["CLOUDFLARE_API_TOKEN"]}'
    })).toEqual({
      provider: "amazon-bedrock",
      baseUrl: "https://gateway.example.com/bedrock",
      protocol: "bedrock-converse",
      env: ["CLOUDFLARE_API_TOKEN"],
      region: "ap-southeast-1"
    })
    expect(() => providerAnswersFrom({
      provider: "amazon-bedrock",
      config: '{"baseUrl":"https://gateway.example.com/bedrock","env":["CLOUDFLARE_API_TOKEN"]}'
    })).toThrow("must declare region")
  })

  test("custom providers declare their transport and secrets by name", () => {
    expect(providerAnswersFrom({
      provider: "private-gateway",
      config: '{"baseUrl":"https://models.example.com/v1","protocol":"openai-responses","env":["PRIVATE_MODEL_KEY"]}'
    })).toEqual({
      provider: "private-gateway",
      baseUrl: "https://models.example.com/v1",
      protocol: "openai-responses",
      env: ["PRIVATE_MODEL_KEY"]
    })
    expect(() => providerAnswersFrom({
      provider: "openrouter",
      config: '{"env":["OPENROUTER_API_KEY"],"apiKey":"secret"}'
    })).toThrow("unknown field: apiKey")
  })
})

describe("writeSetup", () => {
  test("process credentials override local development values", () => {
    expect(runtimeEnvironmentOf(
      { OPENAI_API_KEY: "deployed" },
      { OPENAI_API_KEY: "local", LOCAL_ONLY: "value" }
    )).toEqual({ OPENAI_API_KEY: "deployed", LOCAL_ONLY: "value" })
  })

  test("the project config and private environment are written separately", async () => {
    const files = await write()
    expect(files).toEqual({
      configPath: projectConfigPathIn(root),
      secretsPath: envPathIn(root)
    })
    expect((await stat(files.secretsPath)).mode & 0o777).toBe(SECRETS_MODE)
    expect(await readFile(gitignorePathIn(root), "utf8")).toContain(".dev.vars*")
  })

  test("configuration is JSONC and the credential is the only environment entry", async () => {
    await write()
    const project = parseProjectConfig(await readFile(projectConfigPathIn(root), "utf8"))
    expect(project.models).toEqual({
      default: { provider: "openai", model_id: "a-model" },
      providers: {
        openai: {
          baseUrl: "https://api.example.com/v1",
          protocol: "openai-responses",
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
    await writeFile(gitignorePathIn(root), "dist/\n")
    await writeFile(projectConfigPathIn(root), "{\n  // Keep this setting.\n  \"later\": true\n}\n")
    await write()
    expect(await readFile(envPathIn(root), "utf8")).toContain("# application\nAPP_NAME=release\n")
    expect(await readFile(gitignorePathIn(root), "utf8")).toBe("dist/\n.dev.vars*\n")
    const config = await readFile(projectConfigPathIn(root), "utf8")
    expect(config).toContain("// Keep this setting.")
    expect(config).toContain('"later": true')
  })

  test("an existing Celld manifest receives the shared model config", async () => {
    const celldConfigPath = join(root, CELLD_PROJECT_CONFIG_PATH)
    await writeFile(celldConfigPath, `{
  // Keep this Celld setting.
  "name": "reviewer",
  "vars": { "CELLD_ONLY": "kept", "TARDIGRADE_CONFIG": "{}" }
}\n`)

    const files = await write()
    const celld = await readFile(celldConfigPath, "utf8")
    const config = parse(celld) as { readonly vars: Readonly<Record<string, string>> }

    expect(files.celldConfigPath).toBe(celldConfigPath)
    expect(celld).toContain("// Keep this Celld setting.")
    expect(config.vars["CELLD_ONLY"]).toBe("kept")
    expect(JSON.parse(config.vars["TARDIGRADE_CONFIG"]!)).toEqual({
      models: {
        default: { provider: "openai", model_id: "a-model" },
        providers: {
          openai: {
            baseUrl: "https://api.example.com/v1",
            protocol: "openai-responses",
            env: ["OPENAI_API_KEY"]
          }
        }
      }
    })
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

  test("provider and default writes remain independent", async () => {
    await write()
    const anthropic: ProviderAnswers = {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      credential: "anthropic-key",
      protocol: "anthropic-messages",
      env: ["ANTHROPIC_API_KEY"]
    }
    await Effect.runPromise(Effect.orDie(Effect.provide(writeProviderSetup(root, [anthropic]), BunFileSystem.layer)))
    let project = parseProjectConfig(await readFile(projectConfigPathIn(root), "utf8"))
    expect(project.models.default).toEqual({ provider: "openai", model_id: "a-model" })
    expect(Object.keys(project.models.providers).sort()).toEqual(["anthropic", "openai"])

    await Effect.runPromise(Effect.orDie(Effect.provide(writeDefaultSetup(root, {
      provider: "anthropic",
      model_id: "claude-sonnet-4-6"
    }), BunFileSystem.layer)))
    project = parseProjectConfig(await readFile(projectConfigPathIn(root), "utf8"))
    expect(project.models.default).toEqual({ provider: "anthropic", model_id: "claude-sonnet-4-6" })
  })

  test("a guided plan writes several providers and one default", async () => {
    const second: ProviderAnswers = {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      credential: "router-key",
      protocol: "openai-chat-completions",
      env: ["OPENROUTER_API_KEY"]
    }
    await Effect.runPromise(Effect.orDie(Effect.provide(writeSetupPlan(root, {
      providers: [answers, second],
      default: { provider: "openrouter", model_id: "anthropic/claude-sonnet-4-6" }
    }), BunFileSystem.layer)))
    const project = parseProjectConfig(await readFile(projectConfigPathIn(root), "utf8"))
    const held = await Effect.runPromise(Effect.provide(readSetupEnv(root), BunFileSystem.layer))
    expect(Object.keys(project.models.providers).sort()).toEqual(["openai", "openrouter"])
    expect(project.models.default).toEqual({ provider: "openrouter", model_id: "anthropic/claude-sonnet-4-6" })
    expect(held).toMatchObject({ OPENAI_API_KEY: KEY, OPENROUTER_API_KEY: "router-key" })
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
    expect(json.protocol).toBe("openai-responses")
    expect(summary).toContain("default a-model")
  })

  test("a guided summary lists both manifests and the default once", async () => {
    const celldConfigPath = join(root, CELLD_PROJECT_CONFIG_PATH)
    await writeFile(celldConfigPath, '{ "vars": { "TARDIGRADE_CONFIG": "{}" } }\n')
    const files = await write()
    const summary = setupPlanSummary(files, { providers: [answers], default: {
      provider: answers.provider,
      model_id: answers.model_id
    } })

    expect(summary).toContain(projectConfigPathIn(root))
    expect(summary).toContain(celldConfigPath)
    expect(summary.match(/default openai\/a-model/g)).toHaveLength(1)
  })
})
