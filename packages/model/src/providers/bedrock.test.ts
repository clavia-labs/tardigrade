import { expect, expectTypeOf, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { collectResponse } from "../stream/collect"
import { providerLayer, type BedrockProviderOptions, type ClientOptions, type ModelConfig, type Send } from "./bedrock"
import type { BedrockModelOptions, BedrockOptions } from "./bedrock-contract"
import type { ProviderLayer } from "./layer"

test("Bedrock supports shared host settings and SDK-specific clients", () => {
  expectTypeOf<ModelConfig>().toExtend<BedrockModelOptions>()
  expectTypeOf<typeof providerLayer>().toExtend<ProviderLayer>()
  const shared: BedrockOptions = {
    provider: "bedrock",
    client: { region: "us-east-1", endpoint: "https://example.com", token: { token: "fixture" }, authSchemePreference: ["httpBearerAuth"] },
    model: { model: "fixture", config: { inferenceConfig: { maxTokens: 42, stopSequences: ["stop"] } } }
  }
  const client: ClientOptions = { region: async () => "us-east-1", maxAttempts: 2, credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" } }
  const native: BedrockProviderOptions = { ...shared, client }
  expect(() => providerLayer(shared)).not.toThrow()
  expect(() => providerLayer(native)).not.toThrow()
  expect(() => providerLayer({ ...shared, unvalidatedConfig: { inferenceConfig: { maxTokens: "bad" } } })).toThrow()
})

for (const mode of ["exhausted", "active", "native"] as const) {
  test(`Bedrock tool history respects ${mode} tools`, async () => {
    const inputs: Parameters<Send>[0][] = []
    const prompt = Prompt.make([
      { role: "user", content: "Read the file" },
      { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "read", params: { path: "notes" } }] },
      { role: "tool", content: [{ type: "tool-result", id: "call-1", name: "read", result: "collected findings", isFailure: false }] }
    ])
    const original = JSON.stringify(prompt)
    const layer = providerLayer({ provider: "bedrock", model: { model: "claude", config: mode === "native" ? { toolHistory: "native" } : {} }, client: {
      send: async (input) => {
        inputs.push(input)
        return { $metadata: {}, stream: (async function* () {
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Summary" } } }
          yield { contentBlockStop: { contentBlockIndex: 0 } }
          yield { messageStop: { stopReason: "end_turn" as const } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, metrics: { latencyMs: 1 } } }
        })() }
      }
    } })
    const toolkit = Toolkit.make(Tool.make("read", { parameters: Schema.Struct({ path: Schema.String }) }))
    const response = mode === "active" ? collectResponse(prompt, toolkit) : collectResponse(prompt, Toolkit.make())
    const outcome = await Effect.runPromise(response.pipe(
      Effect.provide(layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.result
    ))
    expect(JSON.stringify(prompt)).toBe(original)
    if (mode === "native") {
      expect(outcome._tag).toBe("Failure")
      expect(inputs).toHaveLength(0)
      return
    }
    expect(outcome._tag).toBe("Success")
    expect(inputs).toHaveLength(1)
    const request = inputs[0]!
    expect(request).not.toHaveProperty("toolHistory")
    if (mode === "active") {
      expect(request.messages?.[1]?.content).toMatchObject([{ toolUse: { toolUseId: "call-1", name: "read", input: { path: "notes" } } }])
      expect(request.messages?.[2]?.content).toMatchObject([{ toolResult: { toolUseId: "call-1" } }])
    } else {
      expect(request.toolConfig).toBeUndefined()
      const history = JSON.stringify(request.messages)
      for (const text of ["<tool_call ", "<tool_result ", "call-1", "read", "notes", "collected findings"]) expect(history).toContain(text)
      expect(request.system).toBeDefined()
    }
  })
}
