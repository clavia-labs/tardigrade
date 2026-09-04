import { describe, expect, test } from "bun:test"

import { actorInstance, apiUrl, DEFAULT_ACTOR_INSTANCE, DEFAULT_API_URL } from "./config"

describe("deployment configuration", () => {
  test("uses visible local defaults", () => {
    expect(actorInstance(undefined)).toBe(DEFAULT_ACTOR_INSTANCE)
    expect(apiUrl(undefined)).toBe(DEFAULT_API_URL)
  })

  test("accepts deployment values", () => {
    expect(actorInstance("production")).toBe("production")
    expect(apiUrl("https://actors.example.com/")).toBe("https://actors.example.com")
  })
})
