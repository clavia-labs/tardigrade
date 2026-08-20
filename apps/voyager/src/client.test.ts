import { afterEach, describe, expect, test } from "bun:test"

import { apiUrl, DEFAULT_API_URL, token, TOKEN_KEY } from "./client"

// The two things a browser decides: which server this tab talks to, and which token it holds.
// Everything else the app does with the server is the client package's (packages/client).

const withGlobal = (name: string, value: unknown, body: () => void) => {
  const held = Reflect.get(globalThis, name)
  const had = name in globalThis
  Reflect.set(globalThis, name, value)
  try {
    body()
  } finally {
    if (had) Reflect.set(globalThis, name, held)
    else Reflect.deleteProperty(globalThis, name)
  }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location")
  Reflect.deleteProperty(globalThis, "localStorage")
})

describe("apiUrl", () => {
  test("with nothing stated it is where the server listens", () => {
    expect(apiUrl()).toBe(DEFAULT_API_URL)
  })

  test("an api query param wins, and a trailing slash is dropped", () => {
    withGlobal("location", { search: "?api=http://127.0.0.1:9000/" }, () => {
      expect(apiUrl()).toBe("http://127.0.0.1:9000")
    })
  })

  test("an empty api param is not a statement", () => {
    withGlobal("location", { search: "?api=" }, () => {
      expect(apiUrl()).toBe(DEFAULT_API_URL)
    })
  })
})

describe("token", () => {
  test("the stored string is the token, and an empty one is no token", () => {
    const stored: Record<string, string> = { [TOKEN_KEY]: "shh" }
    withGlobal("localStorage", { getItem: (key: string) => stored[key] ?? null }, () => {
      expect(token()).toBe("shh")
      stored[TOKEN_KEY] = ""
      expect(token()).toBeUndefined()
      delete stored[TOKEN_KEY]
      expect(token()).toBeUndefined()
    })
  })

  test("a runtime with no localStorage holds no token", () => {
    expect(token()).toBeUndefined()
  })
})
