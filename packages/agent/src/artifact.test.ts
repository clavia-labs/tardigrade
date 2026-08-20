import { describe, expect, test } from "bun:test"

import { defineActor } from "./artifact"

const actor = { reactors: [], keyOf: () => "root" }

describe("defineActor", () => {
  test("keeps a portable named actor", () => {
    const definition = defineActor({ name: "release-analyst", actor })
    expect(definition).toEqual({ name: "release-analyst", actor })
  })

  test("refuses a name that cannot be a path or directory segment", () => {
    expect(() => defineActor({ name: "Release Analyst", actor })).toThrow("actor name must match")
  })
})
