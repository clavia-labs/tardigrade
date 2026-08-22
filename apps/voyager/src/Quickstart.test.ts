import { describe, expect, test } from "bun:test"

import { MIGRATION_PROMPT, QUICKSTART_PROMPT } from "./Quickstart"

describe("QUICKSTART_PROMPT", () => {
  test("points coding agents to the skill", () => {
    expect(QUICKSTART_PROMPT).toContain("skills/tardigrade/SKILL.md")
    expect(QUICKSTART_PROMPT).toContain("Share its Voyager trace URL")
  })
})

describe("MIGRATION_PROMPT", () => {
  test("sets the migration and report contract", () => {
    expect(MIGRATION_PROMPT).toContain("https://github.com/clavia-labs/tardigrade/blob/next/docs/how-to/migrate.md")
    expect(MIGRATION_PROMPT).toContain("end-to-end migration")
    expect(MIGRATION_PROMPT).toContain("same representative task before and after")
    expect(MIGRATION_PROMPT).toContain("Share the Voyager trace URL")
    expect(MIGRATION_PROMPT).toContain("summarize the changes")
    for (const metric of ["harness lines", "dependencies", "model tokens", "cost", "latency"]) {
      expect(MIGRATION_PROMPT).toContain(metric)
    }
    expect(MIGRATION_PROMPT).toContain("percentage changes")
    expect(MIGRATION_PROMPT).toContain("Mark unavailable metrics")
  })
})
