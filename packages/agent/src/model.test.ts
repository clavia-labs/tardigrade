import { describe, expect, test } from "bun:test"

import { modelRefOf } from "./model"

describe("modelRefOf", () => {
  test("reads and normalizes a complete reference", () => {
    expect(modelRefOf({ provider: " openrouter ", model_id: " anthropic/claude-sonnet " })).toEqual({
      provider: "openrouter",
      model_id: "anthropic/claude-sonnet"
    })
  })

  test("refuses incomplete or untyped input", () => {
    expect(modelRefOf({ provider: "openrouter" })).toBeUndefined()
    expect(modelRefOf({ provider: "", model_id: "model" })).toBeUndefined()
    expect(modelRefOf("openrouter/model")).toBeUndefined()
  })
})
