import { describe, expect, test } from "bun:test"

import { callCommand, shellWord } from "./workflow"

describe("the onboarding workflow", () => {
  test("shell words stay copyable", () => {
    expect(shellWord("actor.ts")).toBe("actor.ts")
    expect(shellWord("my actor.ts")).toBe("'my actor.ts'")
    expect(callCommand()).toBe(
      "tdg call message '{\"text\":\"What is the weather in Singapore?\"}' --thread main"
    )
  })

})
