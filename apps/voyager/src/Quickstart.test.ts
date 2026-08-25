import { describe, expect, test } from "bun:test"

import { START_COMMAND, startCommand } from "./Quickstart"

describe("START_COMMAND", () => {
  test("invokes the mounted actor", () => {
    expect(startCommand("http://localhost:4242")).toBe(
      "tdg call message '{\"text\":\"Read this repository and tell me what it does\"}' --url http://localhost:4242"
    )
  })

  test("states a non-default server address", () => {
    expect(startCommand("http://localhost:4241")).toBe(
      `${START_COMMAND} --url http://localhost:4241`
    )
  })
})
