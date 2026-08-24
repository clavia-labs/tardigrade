import { describe, expect, test } from "bun:test"
import {
  MODEL_PROVIDER_CONNECTIONS,
  modelProviderConnectionOf,
  modelProtocolOf
} from "./directory"

describe("model providers", () => {
  test("each supported service states its protocol", () => {
    expect(MODEL_PROVIDER_CONNECTIONS.map(({ id, protocol }) => [id, protocol])).toEqual([
      ["openai", "openai-responses"],
      ["anthropic", "anthropic-messages"],
      ["openrouter", "openai-chat-completions"],
      ["vercel", "openai-responses"],
      ["cloudflare-ai-gateway", "openai-responses"],
      ["azure", "openai-responses"],
      ["google", "openai-chat-completions"],
      ["google-vertex", "openai-chat-completions"],
      ["amazon-bedrock", "bedrock-converse"]
    ])
  })

  test("looks up presets and validates custom protocols", () => {
    expect(modelProviderConnectionOf("amazon-bedrock")).toMatchObject({ region: true })
    expect(modelProviderConnectionOf("custom")).toBeUndefined()
    expect(modelProtocolOf("openai-responses")).toBe("openai-responses")
    expect(() => modelProtocolOf("provider-name")).toThrow("model protocol must be one of")
  })
})
