import { describe, expect, test } from "bun:test"
import {
  amazonBedrock,
  anthropic,
  cloudflareAIGateway,
  googleAI,
  googleVertexAI,
  microsoftFoundry,
  modelDirectory,
  modelProtocolOf,
  openAI,
  openAICompatible,
  openRouter,
  vercelAIGateway
} from "./directory"
import { declaredModelMetadata } from "./metadata"

describe("model providers", () => {
  test("each supported service states its protocol", () => {
    expect(vercelAIGateway().protocol).toBe("openai-responses")
    expect(cloudflareAIGateway().protocol).toBe("openai-responses")
    expect(amazonBedrock().protocol).toBe("bedrock-converse")
    expect(microsoftFoundry().protocol).toBe("openai-responses")
    expect(googleAI().protocol).toBe("openai-chat-completions")
    expect(googleVertexAI().protocol).toBe("openai-chat-completions")
    expect(openAI().protocol).toBe("openai-responses")
    expect(anthropic().protocol).toBe("anthropic-messages")
    expect(openRouter().protocol).toBe("openai-chat-completions")
    expect(openAICompatible({ baseUrl: "https://models.example/v1" }).protocol).toBe("openai-chat-completions")
  })

  test("a provider can state another protocol its endpoint supports", () => {
    expect(vercelAIGateway({ protocol: "anthropic-messages" }).protocol).toBe("anthropic-messages")
    expect(modelProtocolOf("openai-responses")).toBe("openai-responses")
    expect(() => modelProtocolOf("provider-name")).toThrow("model protocol must be one of")
  })
})

describe("model directory", () => {
  const directory = modelDirectory({
    revision: "catalog-7",
    providers: {
      "cloudflare-ai-gateway": {
        route: cloudflareAIGateway(),
        models: {
          "openai/gpt-5.6-luna": declaredModelMetadata({
            contextWindowTokens: 1_050_000,
            maxOutputTokens: 128_000,
            pricing: { promptUsdPerToken: 0.000_001, completionUsdPerToken: 0.000_004 },
            output: { guarantee: "native", withTools: true }
          }, "deployment")
        }
      }
    }
  })

  test("an exact coordinate resolves route, limits, capability, and revision", () => {
    expect(directory.resolve({
      provider: "cloudflare-ai-gateway",
      model_id: "openai/gpt-5.6-luna"
    })).toMatchObject({
      provider: "cloudflare-ai-gateway",
      model_id: "openai/gpt-5.6-luna",
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: { promptUsdPerToken: 0.000_001, completionUsdPerToken: 0.000_004 },
      output: { guarantee: "native", withTools: true },
      catalogRevision: "catalog-7",
      route: { kind: "cloudflare-ai-gateway", protocol: "openai-responses" }
    })
  })

  test("missing providers and metadata fail with an action", () => {
    expect(() => directory.resolve({ provider: "missing", model_id: "m" })).toThrow("run `tdg setup`")
    expect(() => directory.resolve({ provider: "cloudflare-ai-gateway", model_id: "missing" })).toThrow("tdg setup")
  })

  test("construction rejects incomplete revisions and policy", () => {
    expect(() => modelDirectory({ revision: "", providers: {} })).toThrow("revision cannot be empty")
    expect(() => modelDirectory({
      revision: "r1",
      providers: {
        test: {
          route: openAI(),
          models: {
            broken: { contextWindowTokens: { value: 0, source: { kind: "declared", owner: "test" } } }
          }
        }
      }
    })).toThrow("positive integer")
  })
})
