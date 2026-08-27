import { describe, expect, test } from "bun:test"

import { structuredWorkerConfigOf } from "./config"

describe("Worker configuration", () => {
  test("reads object and string bindings", () => {
    const config = { models: { default: { provider: "openai", model_id: "gpt-5.2" }, allow: "*" } }
    expect(structuredWorkerConfigOf(config)).toEqual(config)
    expect(structuredWorkerConfigOf(JSON.stringify(config))).toEqual(config)
  })

  test("refuses invalid JSON and non-object values", () => {
    expect(() => structuredWorkerConfigOf("{")).toThrow("valid JSON")
    expect(() => structuredWorkerConfigOf("[]")).toThrow("JSON object")
    expect(() => structuredWorkerConfigOf(1)).toThrow("JSON object")
  })
})
