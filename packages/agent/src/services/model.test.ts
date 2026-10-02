import { expect, test } from "bun:test"
import { Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ModelLock } from "@clavia/tardigrade-model/lock"
import { BindingSettings, type BindingOptions } from "@clavia/tardigrade-model/settings"
import { requestPolicyOf } from "@clavia/tardigrade-model/stream/request"
import { providerLayer } from "@clavia/tardigrade-model/providers/layer"
import { reasoning, calls, thinking, redacted } from "@clavia/tardigrade-model/testing/fixtures"
import { Model, modelServices, type ModelInput } from "./model"
import { ModelReturned, ModelReply, type Event, type Conversation } from "../contracts/events"
import { TrajectoryState, trajectoryState } from "../atoms/durable/trajectory"

const tool = { name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }
const lock = Layer.succeed(ModelLock, {
  definitions: { schema: 2, providers: {}, models: [] }, listing: async () => ({ revision: "fixture", providers: [] }),
  resolve: model => ({ model: model ?? { provider: "openai", model_id: "gpt-5" }, contextWindowTokens: 10000 }),
})

for (const provider of ["openai", "anthropic"] as const) {
 for (const mode of ["summary", "opaque", "none"] as const) {
  test(`${provider}: durable tool loop carries ${mode} reasoning`, async () => {
    const model = { provider, model_id: provider === "openai" ? "gpt-5" : "claude-sonnet-4-5" }
    const settings: BindingOptions = { provider, protocol: provider === "openai" ? "openai-responses" : "anthropic-messages", model: model.model_id, endpoint: "https://fixture.invalid", policy: requestPolicyOf({}) }
    const nativeReasoning = mode === "none" ? [] : mode === "opaque" ? reasoning.map(item => ({ ...item, summary: [] })) : reasoning
    const nativeThinking = mode === "none" ? [] : mode === "opaque" ? [redacted] : [thinking, redacted]
    const requests: Record<string, Schema.Json>[] = []
    const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requests.push(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(JSON.parse(await new Response(init?.body).text())))
      return Response.json(provider === "openai" ? {
        id: "response", object: "response", created_at: 1, model: model.model_id, status: "completed", output: [...nativeReasoning, ...calls],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      } : {
        id: "message", type: "message", role: "assistant", model: model.model_id,
        content: [...nativeThinking, ...["a", "b", "c"].map(id => ({ type: "tool_use", id, name: "read", input: { path: id } }))],
        stop_reason: "tool_use", stop_sequence: null, container: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, inference_geo: null, server_tool_use: null, service_tier: "standard" },
      })
    }, { preconnect: globalThis.fetch.preconnect })
    const native = providerLayer(provider === "openai"
      ? { provider, client: { apiKey: Redacted.make("test"), apiUrl: "https://fixture.invalid/v1" }, model: { model: model.model_id, config: { store: false } } }
      : { provider, client: { apiKey: Redacted.make("test"), apiUrl: "https://fixture.invalid" }, model: { model: model.model_id, config: { max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 1024 } } } })
    const run = (context: typeof Conversation.Type, identity = settings, selected = model) => Effect.runPromise(Model.use(service => service.call({ model: selected, system: "Read files", tools: [tool], context } satisfies ModelInput)).pipe(
      Effect.provide(modelServices().pipe(Layer.provide(Layer.mergeAll(lock, native.pipe(Layer.provide(FetchHttpClient.layer)), Layer.succeed(BindingSettings, identity))))),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ))
    const reply = Schema.decodeUnknownSync(ModelReply)(JSON.parse(JSON.stringify(await run([{ role: "user", text: "Read files" }]))))
    if (mode === "none") {
      expect(reply).not.toHaveProperty("reasoning")
      expect(reply).not.toHaveProperty("continuation")
    } else {
      expect(reply.reasoning).toBe(mode === "summary" ? "Check" : "")
      expect(reply.continuation).toMatchObject({ provider, protocol: settings.protocol, model: model.model_id })
    }
    expect(reply.toolCalls).toHaveLength(3)
    const recorded = Schema.decodeUnknownSync(ModelReturned)(JSON.parse(JSON.stringify({
      ...reply, type: "ModelReturned", purpose: "inference", callId: "model-call",
      toolCalls: reply.toolCalls.map(call => ({ ...call, providerId: call.callId, callId: `durable-${call.callId}` })),
    })))
    let state: typeof TrajectoryState.Type = { entries: [], models: [] }
    const history: Event[] = [
      { type: "TurnRequested", turnId: "turn", text: "Read files" },
      { type: "ModelCalled", purpose: "inference", callId: "model-call", turnId: "turn", model, contextWindowTokens: 10000 },
      recorded,
    ]
    for (const event of history) state = trajectoryState(state, event)
    state = Schema.decodeUnknownSync(TrajectoryState)(JSON.parse(JSON.stringify(state)))
    for (const id of ["a", "b", "c"]) state = trajectoryState(state, { type: "ToolReturned", callId: `durable-${id}`, output: "contents", error: null })
    const context = state.entries.map(entry => entry.message)
    await run(context)
    if (provider === "openai") {
      expect(requests[1]?.input).toEqual(expect.arrayContaining(nativeReasoning))
      expect(requests[1]?.input).toEqual(expect.arrayContaining(mode === "none" ? calls.map(({ id: _id, ...call }) => call) : calls))
      expect(requests[1]?.input).toEqual(expect.arrayContaining([{ type: "function_call_output", call_id: "a", output: "contents" }]))
    } else if (mode !== "none") {
      if (mode === "summary") expect(JSON.stringify(requests[1])).toContain('"signature":"signed"')
      expect(JSON.stringify(requests[1])).toContain('"data":"opaque"')
    }
    for (const identity of [{ ...settings, provider: "different" }, { ...settings, protocol: "different" }]) await run(context, identity)
    await run(context, settings, { ...model, model_id: "different" })
    for (const request of requests.slice(2)) {
      expect(JSON.stringify(request)).not.toContain("opaque")
      expect(JSON.stringify(request)).not.toContain('"signature"')
      expect(JSON.stringify(request)).toContain("contents")
    }
  })
 }
}

test("historical replies and events retain their shape without reasoning", () => {
  const reply = { text: "answer", toolCalls: [] }
  expect(Schema.decodeSync(ModelReply)(reply)).toEqual(reply)
  const event = { ...reply, type: "ModelReturned", purpose: "inference", callId: "call" } as const
  expect(Schema.decodeSync(ModelReturned)(event)).toEqual(event)
})
