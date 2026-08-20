import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { DEFAULT_BASE_URL } from "@clavia/tardigrade-client"
import { DEFAULT_DB, DEFAULT_PORT } from "@clavia/tardigrade-server/config"

import { configPathIn, parseFileConfig, readFileConfig, resolve, resolveRemote, resolveServer } from "./config"

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

describe("resolveServer", () => {
  test("an empty environment is the server's own defaults", () => {
    const config = resolveServer({}, {})
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.db).toBe(DEFAULT_DB)
    expect(config.token).toBeUndefined()
  })

  test("the environment is the server's surface, model coordinates included", () => {
    const config = resolveServer({}, {
      PORT: "8080",
      TARDIGRADE_DB: "runs.sqlite",
      MODEL_BASE_URL: "https://api.example.com",
      MODEL_API_KEY: "key",
      MODEL_ID: "a-model"
    })
    expect(config.port).toBe(8080)
    expect(config.db).toBe("runs.sqlite")
    expect(config.model.id).toBe("a-model")
  })

  test("a flag beats the environment", () => {
    const config = resolveServer(
      { port: 9000, db: "other.sqlite" },
      { PORT: "8080", TARDIGRADE_DB: "runs.sqlite" }
    )
    expect(config.port).toBe(9000)
    expect(config.db).toBe("other.sqlite")
  })

  // `tdg dev` is the local command and binds loopback (dev.ts, DEV_HOST), so the token the server
  // would gate on is dropped rather than carried: a server meant to be reachable by anyone else is
  // the server run directly.
  test("the token is dropped, so the local server is ungated", () => {
    expect(resolveServer({}, { TARDIGRADE_TOKEN: "secret" }).token).toBeUndefined()
  })

  // The reader is the server's own, so a value it refuses is a value this command refuses.
  test("a PORT that is not a port refuses to resolve", () => {
    expect(() => resolveServer({}, { PORT: "http" })).toThrow()
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
    expect(parseFileConfig(JSON.stringify({ model: { id: "a-model", weird: 3 }, later: true }))).toEqual({
      model: { id: "a-model" }
    })
  })

  test("the file is the third source for the model, and the environment beats it", async () => {
    await put(JSON.stringify({ model: { baseUrl: "https://file.example.com", apiKey: "file-key", id: "file-model" } }))
    const file = await read({ HOME: home })
    const fromFile = resolveServer({}, {}, file)
    expect(fromFile.model).toEqual({
      baseUrl: "https://file.example.com",
      apiKey: "file-key",
      id: "file-model",
      provider: undefined
    })
    const overridden = resolveServer({}, { MODEL_ID: "env-model" }, file)
    expect(overridden.model.id).toBe("env-model")
    expect(overridden.model.baseUrl).toBe("https://file.example.com")
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
