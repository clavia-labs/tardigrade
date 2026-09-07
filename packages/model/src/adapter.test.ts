import { describe, expect, test } from "bun:test"
import { modelAdapters, type ModelAdapter } from "./adapter"

const adapter = (id: string, protocols: ModelAdapter["protocols"]): ModelAdapter => ({
  id,
  protocols,
  start: () => { throw new Error("unused") }
})

describe("model adapter registry", () => {
  test("resolves each protocol to its registered implementation", () => {
    const openai = adapter("openai", ["openai-responses", "openai-chat-completions"])
    const anthropic = adapter("anthropic", ["anthropic-messages"])
    const registry = modelAdapters(openai, anthropic)
    expect(registry.protocols).toEqual(["openai-responses", "openai-chat-completions", "anthropic-messages"])
    expect(registry.resolve("openai-responses")).toBe(openai)
    expect(registry.resolve("anthropic-messages")).toBe(anthropic)
  })

  test("rejects duplicate and unavailable protocols during construction or resolution", () => {
    expect(() => modelAdapters(
      adapter("first", ["anthropic-messages"]),
      adapter("second", ["anthropic-messages"])
    )).toThrow("has adapters")
    expect(() => modelAdapters().resolve("bedrock-converse")).toThrow("has no registered adapter")
  })
})
