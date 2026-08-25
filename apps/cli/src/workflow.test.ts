import { describe, expect, test } from "bun:test"

import { callCommand, shellWord, traceUrlFor } from "./workflow"

describe("the onboarding workflow", () => {
  test("shell words stay copyable", () => {
    expect(shellWord("actor.ts")).toBe("actor.ts")
    expect(shellWord("my actor.ts")).toBe("'my actor.ts'")
    expect(callCommand()).toBe(
      "tdg call message '{\"text\":\"Read this repository and tell me what it does\"}'"
    )
  })

  test("a call links to its Voyager trace", () => {
    expect(traceUrlFor("http://localhost:4242/v1", "thread/1")).toBe(
      "http://localhost:4242/?thread=thread%2F1"
    )
  })
})
