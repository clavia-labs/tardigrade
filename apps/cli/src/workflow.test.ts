import { describe, expect, test } from "bun:test"

import { runCommandFor, shellWord, traceUrlFor } from "./workflow"

describe("the onboarding workflow", () => {
  test("shell words stay copyable", () => {
    expect(shellWord("actor.ts")).toBe("actor.ts")
    expect(shellWord("my actor.ts")).toBe("'my actor.ts'")
    expect(runCommandFor("researcher")).toBe(
      "tdg run 'Read this repository and tell me what it does' --actor researcher"
    )
  })

  test("a run links to its Voyager trace", () => {
    expect(traceUrlFor("http://localhost:4242/v1", "research agent", "thread/1")).toBe(
      "http://localhost:4242/?actor=research+agent&thread=thread%2F1"
    )
  })
})
