import type { OpenRouterLanguageModel } from "@tardie/ai-openrouter"
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { modelLayer } from "@clavia/tardigrade-model/host"
import { collectResponse } from "@clavia/tardigrade-model/stream/collect"
import { inferenceClient } from "../../../testing/inference"
import { durableReact } from "../../../testing/durable-inference"

const details: OpenRouterLanguageModel.ReasoningDetails = [
  { type: "reasoning.text", text: "Check the files.", signature: "signed", format: "anthropic-claude-v1", index: 0 },
  { type: "reasoning.encrypted", data: "opaque", format: "google-gemini-v1", index: 1 }
]
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.25, cost_details: { upstream_inference_cost: 0.2, upstream_inference_prompt_cost: 0.1, upstream_inference_completions_cost: 0.1 } }
const toolkit = Toolkit.make(Tool.make("read", { parameters: Schema.Struct({ path: Schema.String }), failureMode: "return" }))
const frames = (outcome: "calls" | "length" | "malformed" | "stop") => [
  { provider: "Anthropic", choices: [{ index: 0, delta: { reasoning_details: details } }] },
  { choices: [{ index: 0, delta: outcome === "stop" ? { content: "Done." } : { tool_calls: ["a", "b", "c"].map((id, index) => ({ index, id, type: "function", function: { name: "read", arguments: outcome !== "calls" && id === "b" ? '{"path":' : JSON.stringify({ path: id === "b" ? 123 : id }) } })) } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: outcome === "stop" ? "stop" : outcome === "length" ? "length" : "tool_calls" }] },
  { choices: [], usage }
].map((event) => `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", model: "anthropic/routed-model", created: 1, ...event })}\n\n`).join("") + "data: [DONE]\n\n"

for (const outcome of ["calls", "length", "malformed"] as const) test(`OpenRouter persists ${outcome} evidence and replays native reasoning`, async () => {
  const requests: Array<{ messages: Array<Record<string, unknown>>; reasoning_effort?: string; max_tokens?: number; provider?: unknown }> = []
  const fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    expect(String(input)).toBe("https://fixture.invalid/v1/chat/completions")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test")
    requests.push(JSON.parse(await new Response(init?.body).text()))
    const bytes = new TextEncoder().encode(frames(requests.length === 1 ? outcome : "stop"))
    let offset = 0
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return }
      controller.enqueue(bytes.slice(offset, offset + 17)); offset = Math.min(offset + 17, bytes.length)
    } }), { headers: { "content-type": "text/event-stream" } })
  }, { preconnect: globalThis.fetch.preconnect })
  const reference = { provider: "openrouter", model_id: "requested-model" }
  const layer = modelLayer({ model: { default: reference, allow: "*", providers: { openrouter: { baseUrl: "https://fixture.invalid/v1", protocol: "openai-chat-completions", env: ["KEY"], models: { "requested-model": { options: { reasoning_effort: "high" } } } } } }, modelCredentials: { KEY: "test" } }, {
    snapshot: { source: "models.dev", revision: "r1", refreshedAt: 1, status: "fresh", providers: [{ id: "openrouter", name: "OpenRouter", env: [], models: [{ id: "requested-model", metadata: { contextWindowTokens: 200000, maxOutputTokens: 150 } }] }] }
  }, { configure: () => ({ openrouter: { max_tokens: 200, provider: { order: ["Anthropic"] } }, retry: { backoffMs: [] } }) })
  const action = await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* inferenceClient
    return yield* durableReact(infer, { model: reference, identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] })
  }).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch)))
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ reasoning_effort: "high", max_tokens: 150, provider: { order: ["Anthropic"] } })
  expect(action.response).toMatchObject({ id: "chat-1", modelId: "anthropic/routed-model" })
  expect(action.finish?.metadata).toMatchObject({ openrouter: { provider: "Anthropic", usage } })
  expect(action.usage).toMatchObject({ inputTokens: { total: 10 }, outputTokens: { total: 5 } })
  expect(action.reportedCostUsd).toBe(0.25)
  expect(action.kind).toBe(outcome === "calls" ? "calls" : "fail")
  if (outcome !== "calls") return
  expect(action.continuation).toBeDefined()
  const restored = Schema.decodeUnknownSync(Prompt.Prompt)(JSON.parse(JSON.stringify(action.continuation!.payload)))
  await Effect.runPromise(collectResponse(Prompt.concat(restored, Prompt.make([{ role: "tool", content: ["a", "b", "c"].map((id) => ({ type: "tool-result" as const, id, name: "read", result: id === "b" ? "Invalid path" : "contents", isFailure: id === "b" })) }])), toolkit).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch)))
  const assistants = requests[1]?.messages.filter((message) => message.role === "assistant")
  expect(assistants).toHaveLength(1)
  expect(assistants?.[0]).toMatchObject({ reasoning_details: details, tool_calls: ["a", "b", "c"].map((id) => ({ id })) })
})
