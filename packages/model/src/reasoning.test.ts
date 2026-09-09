import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Infer, renderOf, codeMode, nativeOutput, NATIVE_MODE } from "@clavia/tardigrade-agent"
import { modelAdapters, type ModelAdapter, type ModelAdapterContext } from "./adapter"
import { openAICompatibleAdapter } from "./openai"
import { anthropicAdapter } from "./anthropic"
import { bedrockAdapter } from "./bedrock"
import { protocolOptionsOf, type ModelOptionsByProtocol } from "./reasoning"
import { canonicalModelConfig, modelConfigOf } from "./config"
import { modelLayer } from "./host"
import type { ModelProtocol } from "./directory"

const request = {
  trajectory: [],
  messages: [],
  identity: { actor: "test", instance: "main", thread: "root", turn: "turn" },
  ...renderOf([codeMode(), nativeOutput], [])
}
const contextOf = (protocol: ModelProtocol, options?: ModelOptionsByProtocol[ModelProtocol]): ModelAdapterContext => ({
  config: { baseUrl: "https://model.test/v1", apiKey: "test", model: "test-model", provider: "test", contextWindowTokens: 128_000, ...protocolOptionsOf(protocol, options) },
  request: { system: "", tools: [], messages: [] },
  identity: request.identity,
  mode: NATIVE_MODE,
  maxTokens: 4096,
  bounds: { firstChunkMs: 1000, idleMs: 1000, totalMs: 1000 },
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
  systemPrompts: [],
  fetch: async () => new Response()
})

const bodyOf = async (protocol: ModelProtocol, options?: ModelOptionsByProtocol[ModelProtocol]) => {
  let body: Record<string, unknown> | undefined
  const context = contextOf(protocol, options)
  const attempt = (protocol === "anthropic-messages" ? anthropicAdapter : openAICompatibleAdapter).start({
    ...context,
    fetch: async (input, init) => {
      const outgoing = input instanceof Request ? input : new Request(String(input), init)
      body = JSON.parse(await outgoing.text())
      return new Response("", { headers: { "content-type": "text/event-stream" } })
    }
  })
  for await (const _chunk of attempt.stream) {}
  expect(body).toBeDefined()
  return body!
}

describe("reasoning controls", () => {
  test.each(["openai-responses", "openai-chat-completions", "anthropic-messages"] as const)("%s preserves provider defaults when omitted", async (protocol) => {
    const body = await bodyOf(protocol)
    for (const field of ["thinking", "reasoning", "reasoning_effort", "output_config"]) expect(body).not.toHaveProperty(field)
  })
  test.each(["high", "none"] as const)("OpenAI sends explicit effort %s on each wire", async (effort) => {
    const responses = await bodyOf("openai-responses", { reasoning: { effort } })
    expect(responses.reasoning).toEqual({ effort })
    expect(responses).not.toHaveProperty("reasoning_effort")
    const chat = await bodyOf("openai-chat-completions", { reasoning_effort: effort })
    expect(chat.reasoning_effort).toBe(effort)
    expect(chat).not.toHaveProperty("reasoning")
  })
  test.each([
    [{ type: "adaptive" }, { type: "adaptive" }],
    [{ type: "disabled" }, { type: "disabled" }],
    [{ type: "adaptive", display: "summarized" }, { type: "adaptive", display: "summarized" }],
    [{ type: "adaptive", display: "omitted" }, { type: "adaptive", display: "omitted" }],
    [{ type: "enabled", budget_tokens: 2048 }, { type: "enabled", budget_tokens: 2048 }]
  ] as const)("Anthropic sends thinking %j and effort", async (thinking, wire) => {
    const body = await bodyOf("anthropic-messages", { thinking, output_config: { effort: "high" } })
    expect(body.thinking).toEqual(wire)
    expect(body.output_config).toEqual({ effort: "high" })
    expect(body.max_tokens).toBe(4096)
  })
  test("Anthropic rejects a thinking budget that would increase the output cap before fetching", () => {
    expect(() => anthropicAdapter.start(contextOf("anthropic-messages", { thinking: { type: "enabled", budget_tokens: 4096 } }))).toThrow("request output token limit")
  })
  test.each([
    null, [], { typo: "high" }, { output_config: { effort: "" } }, { output_config: { effort: 3 } }, { output_config: { effort: "none" } },
    { thinking: { type: "adaptive", display: "unknown" } },
    { thinking: { type: "enabled", budgetTokens: 2048 } },
    { thinking: { type: "disabled", display: "omitted" } },
    { thinking: { type: "unknown" } }, { thinking: { type: "enabled" } },
    { thinking: { type: "adaptive", budget_tokens: 12 } },
    { thinking: { type: "enabled", budget_tokens: -1 } },
    { thinking: { type: "enabled", budget_tokens: 1.5 } }
  ].map((value) => [value] as const))("rejects invalid controls %j", (value) => {
    expect(() => protocolOptionsOf("anthropic-messages", value)).toThrow()
  })
  test("protocol effort values are checked for external configuration", async () => {
    expect(() => protocolOptionsOf("openai-responses", { reasoning: { effort: "max" } })).toThrow("unsupported")
    expect(() => protocolOptionsOf("openai-chat-completions", { reasoning_effort: "future-provider-level" })).toThrow("unsupported")
    expect(() => protocolOptionsOf("openai-responses", { reasoning: { effort: null } })).toThrow("unsupported")
    expect((await bodyOf("anthropic-messages", { output_config: { effort: null } })).output_config).toEqual({ effort: null })
  })
  test("unsupported protocol controls fail explicitly", () => {
    expect(() => openAICompatibleAdapter.start(contextOf("openai-responses", { thinking: { type: "adaptive" } }))).toThrow("unsupported fields")
    expect(() => bedrockAdapter.start(contextOf("bedrock-converse", { reasoning: { effort: "high" } }))).toThrow("not supported")
  })
  test.each([null, [], { "": { effort: "high" } }, { a: { typo: true } }, { a: null }, { a: { options: { thinking: { type: "adaptive" } } } }].map((value) => [value] as const))("host rejects invalid model maps %j", (models) => {
    expect(() => modelConfigOf({
      default: { provider: "test", model_id: "a" }, allow: "*",
      providers: { test: { baseUrl: "https://model.test", protocol: "openai-responses", env: ["KEY"], models } }
    })).toThrow()
  })
  test("host selects per-model controls and deployment digest includes them", async () => {
    const config = modelConfigOf({
      default: { provider: "test", model_id: "a" }, allow: "*",
      providers: { test: { baseUrl: "https://model.test", protocol: "openai-responses", env: ["KEY"], models: { a: { options: { reasoning: { effort: "high" } } }, b: { options: { reasoning: { effort: "low" } } }, c: {} } } }
    })
    const seen: unknown[] = []
    const adapter: ModelAdapter = { id: "capture", protocols: ["openai-responses"], start: (context) => {
      seen.push(context.config.options)
      return { stream: (async function* () { throw new Error("captured") } )() }
    } }
    const layer = modelLayer({ model: config, modelCredentials: { KEY: "test" } }, {
      snapshot: { source: "models.dev", revision: "test", refreshedAt: 0, status: "fresh", providers: [{ id: "test", name: "Test", env: ["KEY"], models: ["a", "b", "c", "d"].map((id) => ({ id, metadata: { contextWindowTokens: 128_000 } })) }] }
    }, modelAdapters(adapter))
    for (const model_id of ["a", "b", "c", "d"]) await Effect.runPromise(Effect.flatMap(Infer, (binding) => binding.react({ ...request, model: { provider: "test", model_id } }, "key", new AbortController().signal)).pipe(Effect.provide(layer)))
    expect(seen).toEqual([{ reasoning: { effort: "high" } }, { reasoning: { effort: "low" } }, undefined, undefined])
    expect(modelConfigOf(JSON.parse(canonicalModelConfig(config)))).toEqual(config)
    expect(canonicalModelConfig(config)).not.toBe(canonicalModelConfig({ ...config, providers: { test: { ...config.providers.test!, protocol: "openai-responses", models: { a: { options: { reasoning: { effort: "low" } } } } } } }))
  })
})
