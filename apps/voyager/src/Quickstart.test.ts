import { describe, expect, test } from "bun:test"

import { QUICKSTART_PROMPT } from "./Quickstart"

describe("QUICKSTART_PROMPT", () => {
  test("points coding agents to the skill", () => {
    expect(QUICKSTART_PROMPT).toContain("skills/tardigrade/SKILL.md")
    expect(QUICKSTART_PROMPT).toContain("Share its Voyager trace URL")
  })
})
