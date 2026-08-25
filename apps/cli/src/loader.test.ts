import { describe, expect, test } from "bun:test"

import { withLoader } from "./loader"

describe("withLoader", () => {
  test("animates an enabled task and clears its line", async () => {
    const writes: Array<string> = []
    const result = await withLoader("Installing dependencies", () => Promise.resolve("done"), {
      enabled: true,
      intervalMillis: 10_000,
      write: (text) => writes.push(text)
    })

    expect(result).toBe("done")
    expect(writes[0]).toContain("◐ Installing dependencies")
    expect(writes.at(-1)).toBe("\r\u001b[2K")
  })

  test("stays silent when disabled", async () => {
    const writes: Array<string> = []
    await withLoader("Installing dependencies", () => Promise.resolve(), {
      enabled: false,
      write: (text) => writes.push(text)
    })

    expect(writes).toEqual([])
  })
})
