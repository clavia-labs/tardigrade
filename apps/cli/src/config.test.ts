import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { DEFAULT_BASE_URL } from "@clavia/tardigrade-client"
import { readConfig } from "@clavia/tardigrade-server/config"

import {
  configPathIn,
  parseFileConfig,
  parseProjectConfig,
  projectConfigPathIn,
  readFileConfig,
  readProjectConfig,
  resolve,
  resolveRemote
} from "./config"

// Configuration resolves in one place, and the order is the whole of what these assert: a flag
// beats the environment, the environment beats the file, the file beats the default, and a blank
// value is not a value at any level.

describe("resolveRemote", () => {
  test("an empty environment is the client's own default", () => {
    expect(resolveRemote({}, {})).toEqual({ baseUrl: DEFAULT_BASE_URL, token: undefined })
  })

  test("the environment carries the token", () => {
    expect(resolveRemote({}, { TARDIGRADE_TOKEN: "secret" }).token).toBe("secret")
  })

  test("a flag beats the environment", () => {
    const resolved = resolveRemote(
      { url: "https://agents.example.com", token: "stated" },
      { TARDIGRADE_TOKEN: "secret" }
    )
    expect(resolved).toEqual({ baseUrl: "https://agents.example.com", token: "stated" })
  })

  test("a blank value is an absent one", () => {
    expect(resolveRemote({ url: "   " }, { TARDIGRADE_TOKEN: "" })).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      token: undefined
    })
  })
})

describe("resolve", () => {
  // The order is one function, so every value the command line resolves takes the same one.
  test("a flag beats a variable beats the file, and blank is absent at every level", () => {
    expect(resolve("flag", "variable", "file")).toBe("flag")
    expect(resolve(undefined, "variable", "file")).toBe("variable")
    expect(resolve(undefined, undefined, "file")).toBe("file")
    expect(resolve("  ", "  ", "  ")).toBeUndefined()
    expect(resolve("  ", "variable", "file")).toBe("variable")
  })
})

describe("the config file", () => {
  let home = ""

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "tdg-config-"))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const put = async (contents: string) => {
    await mkdir(join(home, ".tardigrade"), { recursive: true })
    await writeFile(configPathIn(home), contents)
  }

  const read = (env: Record<string, string | undefined>) =>
    Effect.runPromise(Effect.provide(readFileConfig(env), BunFileSystem.layer))

  test("a home with no file is an empty configuration", async () => {
    expect(await read({ HOME: home })).toEqual({})
  })

  test("no home is an empty configuration", async () => {
    expect(await read({})).toEqual({})
  })

  // A file this command cannot read is the third source answering nothing, never a command that
  // refuses to run: the flags and the environment may already say enough.
  test("a malformed file is an empty configuration", async () => {
    await put("{ not json")
    expect(await read({ HOME: home })).toEqual({})
  })

  test("a key nobody declared is ignored, and the rest still reads", () => {
    expect(parseFileConfig(JSON.stringify({ model: { old: true }, later: true, url: "https://example.com" })))
      .toEqual({ url: "https://example.com" })
  })

  test("project JSONC supplies provider configuration and the environment supplies credentials", () => {
    const project = parseProjectConfig(`{
      // This file contains no credential values.
      "vars": {
        "TARDIGRADE_CONFIG": {
          "models": {
            "default": { "provider": "openai", "model_id": "file-model" },
            "allow": "*",
            "providers": {
              "openai": {
                "baseUrl": "https://file.example.com",
                "protocol": "openai-responses",
                "env": ["OPENAI_API_KEY"]
              }
            }
          }
        }
      }
    }`)
    const resolved = readConfig({ OPENAI_API_KEY: "environment-key" }, project)
    expect(resolved.model).toEqual({
      default: { provider: "openai", model_id: "file-model" },
      allow: "*",
      providers: {
        openai: {
          baseUrl: "https://file.example.com",
          protocol: "openai-responses",
          env: ["OPENAI_API_KEY"]
        }
      }
    })
    expect(resolved.modelCredentials).toEqual({ OPENAI_API_KEY: "environment-key" })
  })

  test("the project path is configurable and JSONC comments are accepted", async () => {
    const path = projectConfigPathIn(home, { TARDIGRADE_CONFIG_PATH: "config/custom.jsonc" })
    await mkdir(join(home, "config"), { recursive: true })
    await writeFile(path, '{ // visible\n "vars": { "TARDIGRADE_CONFIG": { "models": { "allow": "*" } } }\n}')
    const project = await Effect.runPromise(Effect.provide(
      readProjectConfig(home, { TARDIGRADE_CONFIG_PATH: "config/custom.jsonc" }),
      BunFileSystem.layer
    ))
    expect(project.models).toEqual({ allow: "*", providers: {} })
  })

  test("the file is the third source for the remote, and a flag beats both", async () => {
    await put(JSON.stringify({ url: "https://file.example.com", token: "file-token" }))
    const file = await read({ HOME: home })
    expect(resolveRemote({}, {}, file)).toEqual({ baseUrl: "https://file.example.com", token: "file-token" })
    expect(resolveRemote({}, { TARDIGRADE_TOKEN: "env-token" }, file).token).toBe("env-token")
    expect(resolveRemote({ url: "https://flag.example.com", token: "flag" }, { TARDIGRADE_TOKEN: "env-token" }, file))
      .toEqual({ baseUrl: "https://flag.example.com", token: "flag" })
  })
})
