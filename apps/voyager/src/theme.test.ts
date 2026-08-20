import { beforeEach, describe, expect, test } from "bun:test"

import { chosenTheme, THEME_KEY } from "./theme"

// The one theme decision that is not the document's: what a stored value means. A record the app
// did not write, or one it wrote in an older vocabulary, is no choice at all and the system
// preference keeps deciding.

const store = new Map<string, string>()

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => void store.set(key, value)
  }
})

describe("chosenTheme", () => {
  beforeEach(() => store.clear())

  test("no record is no choice", () => {
    expect(chosenTheme()).toBeUndefined()
  })

  test("a recorded theme is the choice", () => {
    store.set(THEME_KEY, "dark")
    expect(chosenTheme()).toBe("dark")
  })

  test("a record the app cannot read is no choice", () => {
    store.set(THEME_KEY, "moss")
    expect(chosenTheme()).toBeUndefined()
  })
})
