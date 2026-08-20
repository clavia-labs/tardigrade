import { describe, expect, test } from "bun:test"

import { quickstartCommands } from "./Quickstart"

describe("quickstartCommands", () => {
  test("both commands address the server this tab reads", () => {
    const commands = quickstartCommands("http://localhost:4241")
    expect(commands.cli).toContain("--url http://localhost:4241")
    expect(commands.curl).toContain("http://localhost:4241/v1/actors/default/threads/hello/events")
  })
})
