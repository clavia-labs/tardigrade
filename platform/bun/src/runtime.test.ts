import { describe, expect, test } from "bun:test"
import { MINIMUM_BUN_VERSION, assertSupportedBun, supportsBunVersion } from "./runtime"

describe("Bun compatibility", () => {
  test("the supported range starts at Bun 1.4", () => {
    expect(MINIMUM_BUN_VERSION).toBe("1.4.0")
    expect(supportsBunVersion("1.3.14")).toBe(false)
    expect(supportsBunVersion("1.4.0-canary.1")).toBe(true)
    expect(supportsBunVersion("1.4.1")).toBe(true)
    expect(supportsBunVersion("unknown")).toBe(false)
  })

  test("the runtime check names the installed and required versions", () => {
    expect(() => assertSupportedBun("1.3.1")).toThrow("Tardigrade requires Bun 1.4.0 or later. Found Bun 1.3.1.")
    expect(() => assertSupportedBun("1.4.0")).not.toThrow()
  })
})
