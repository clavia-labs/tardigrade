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

const answers: SetupAnswers = { baseUrl: "https://api.example.com/v1", id: "a-model", apiKey: KEY }

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
    expect(PRESETS.length).toBeLessThanOrEqual(5)
    for (const preset of PRESETS) {
      if (preset.baseUrl !== undefined) expect(preset.baseUrl.startsWith("https://")).toBe(true)
      expect(preset.title.length).toBeGreaterThan(0)
    }
    expect(PRESETS.some((preset) => preset.provider === "bedrock")).toBe(true)
    expect(PRESETS.some((preset) => preset.baseUrl === undefined && preset.provider === undefined)).toBe(true)
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

  test("the answers land as the model block, provider included when one was chosen", async () => {
    const path = await write({ ...answers, provider: "bedrock" })
    const held = parseFileConfig(await readFile(path, "utf8"))
    expect(held.model).toEqual({
      baseUrl: "https://api.example.com/v1",
      apiKey: KEY,
      id: "a-model",
      provider: "bedrock"
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
    expect(held.model?.id).toBe("a-model")
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
    await write({ ...answers, provider: "bedrock" })
    const file = await Effect.runPromise(Effect.provide(readFileConfig({ HOME: home }), BunFileSystem.layer))
    expect(file.model).toEqual({
      baseUrl: "https://api.example.com/v1",
      apiKey: KEY,
      id: "a-model",
      provider: "bedrock"
    })
  })
})

describe("what setup prints", () => {
  // The key is the one value that is written and never shown. Neither rendering may carry it, and
  // neither may the path line, so there is nothing to scrub from a shared terminal.
  test("the key is never echoed, in either rendering", async () => {
    const path = await write({ ...answers, provider: "bedrock" })
    const summary = setupSummary(path, { ...answers, provider: "bedrock" })
    expect(summary).not.toContain(KEY)
    expect(summary).toContain(path)
    expect(summary).toContain("a-model")
    expect(summary).toContain("stored")
    const json = setupJson(path, { ...answers, provider: "bedrock" })
    expect(JSON.stringify(json)).not.toContain(KEY)
    expect(json.apiKey).toBe("stored")
    expect(json.provider).toBe("bedrock")
  })
})

describe("homeOf", () => {
  test("an unset or blank HOME is no home at all", () => {
    expect(homeOf({})).toBeUndefined()
    expect(homeOf({ HOME: "  " })).toBeUndefined()
    expect(homeOf({ HOME: "/home/someone" })).toBe("/home/someone")
  })
})
