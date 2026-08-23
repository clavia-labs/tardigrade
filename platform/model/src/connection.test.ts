import { describe, expect, test } from "bun:test"
import {
  amazonBedrock,
  anthropic,
  azureAI,
  cloudflareAIGateway,
  googleVertexAI,
  modelCatalog,
  modelDriverOf,
  openAI,
  openAICompatible,
  openRouter,
  vercelAIGateway
} from "./connection"
import { declaredModelMetadata } from "./metadata"

describe("model connections", () => {
  test("each supported service states its protocol driver", () => {
    expect(vercelAIGateway().driver).toBe("openai-responses")
    expect(cloudflareAIGateway().driver).toBe("openai-responses")
    expect(amazonBedrock().driver).toBe("bedrock-converse")
    expect(azureAI().driver).toBe("openai-responses")
    expect(googleVertexAI().driver).toBe("openai-chat-completions")
    expect(openAI().driver).toBe("openai-responses")
    expect(anthropic().driver).toBe("anthropic-messages")
    expect(openRouter().driver).toBe("openai-chat-completions")
    expect(openAICompatible({ baseUrl: "https://models.example/v1" }).driver).toBe("openai-chat-completions")
  })

  test("a connection can state another protocol the endpoint supports", () => {
    expect(vercelAIGateway({ driver: "anthropic-messages" }).driver).toBe("anthropic-messages")
    expect(modelDriverOf("openai-responses")).toBe("openai-responses")
    expect(() => modelDriverOf("provider-name")).toThrow("model driver must be one of")
  })
})

describe("model catalog", () => {
  const catalog = modelCatalog({
    revision: "catalog-7",
    default: { id: "openai/gpt-5.6-luna", connection: "managed" },
    connections: { managed: cloudflareAIGateway() },
    models: {
      default: {
        id: "openai/gpt-5.6-luna",
        connection: "managed",
        metadata: declaredModelMetadata({
          contextWindowTokens: 1_050_000,
          maxOutputTokens: 128_000,
          output: { guarantee: "native", withTools: true }
        }, "deployment")
      }
    }
  })

  test("a logical name resolves route, limits, capability, and revision together", () => {
    expect(catalog.resolve("default")).toMatchObject({
      name: "default",
      id: "openai/gpt-5.6-luna",
      connection: "managed",
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
      output: { guarantee: "native", withTools: true },
      catalogRevision: "catalog-7",
      route: { kind: "cloudflare-ai-gateway", driver: "openai-responses" },
      metadata: { contextWindowTokens: { source: { kind: "declared", owner: "deployment" } } }
    })
  })

  test("an explicit id and connection still requires catalog metadata", () => {
    expect(catalog.resolve()).toMatchObject({ id: "openai/gpt-5.6-luna", connection: "managed" })
    expect(catalog.resolve("openai/gpt-5.6-luna")).toMatchObject({ connection: "managed" })
    expect(catalog.resolve({ id: "openai/gpt-5.6-luna", connection: "managed" }).name).toBe("default")
    expect(() => catalog.resolve({ id: "unknown", connection: "managed" })).toThrow("has no declared metadata")
    expect(() => catalog.resolve("unknown")).toThrow("has no declared metadata")
  })

  test("construction rejects incomplete coordinates and policy", () => {
    expect(() => modelCatalog({
      revision: "",
      connections: {},
      models: {}
    })).toThrow("revision cannot be empty")
    expect(() => modelCatalog({
      revision: "r1",
      connections: {},
      models: {
        broken: {
          id: "m",
          connection: "missing",
          metadata: declaredModelMetadata({ contextWindowTokens: 1 }, "test")
        }
      }
    })).toThrow("unknown connection")
  })
})
