import { describe, expect, test } from "bun:test"
import { DEFAULT_BASE_URL } from "@clavia/tardigrade-client"
import { DEFAULT_DB, DEFAULT_PORT } from "@clavia/tardigrade-server/config"

import { resolveRemote, resolveServer } from "./config"

// Configuration resolves in one place, and the order is the whole of what these assert: a flag
// beats the environment, the environment beats the default, and a blank variable is not a value.

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
