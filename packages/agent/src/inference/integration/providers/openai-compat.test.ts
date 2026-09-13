import { inferenceClient } from "@clavia/tardigrade-agent/testing/inference"
import { expect, test } from "bun:test"
import { Effect, Layer, Redacted, Result, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { collectResponse } from "@clavia/tardigrade-model/stream/collect"
import { providerLayer } from "@clavia/tardigrade-model/providers/layer"
import { modelLayer } from "@clavia/tardigrade-model/host"

const toolkit = Toolkit.make(Tool.make("read", { parameters: Schema.Struct({ path: Schema.String }), failureMode: "return" }))
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 }, cost: 0.25 }
const frames = (field: "reasoning" | "reasoning_content", truncated = false) => [
  { choices: [{ index: 0, delta: { [field]: "Check the files." } }] },
  { choices: [{ index: 0, delta: { content: "Reading." } }] },
  { choices: [{ index: 0, delta: { tool_calls: ["a", "b", "c"].map((id, index) => ({ index, id, type: "function", function: { name: "read", arguments: truncated ? '{"path":' : JSON.stringify({ path: id === "b" ? 123 : id }) } })) } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: truncated ? "length" : "tool_calls" }] },
  { choices: [], usage }
].map((event) => `data: ${JSON.stringify({ id: "chat-1", model: "gateway-model", created: 1, ...event })}\n\n`).join("") + "data: [DONE]\n\n"

for (const field of ["reasoning", "reasoning_content"] as const) {
  test(`compat: ${field} survives JSON replay beside validated and rejected calls`, async () => {
    const requests: Array<{ messages: Array<Record<string, unknown>>; reasoning_effort?: string; response_format?: unknown }> = []
    const fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("https://fixture.invalid/v1/chat/completions")
      requests.push(JSON.parse(await new Response(init?.body).text()))
      const bytes = new TextEncoder().encode(frames(field))
      let index = 0
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (index < bytes.length) { controller.enqueue(bytes.slice(index, index + 17)); index += 17 }
        else controller.close()
      } }), { headers: { "content-type": "text/event-stream" } })
    }, { preconnect: globalThis.fetch.preconnect })
    const layer = providerLayer({ provider: "openai-compat", client: { apiKey: Redacted.make("test"), apiUrl: "https://fixture.invalid/v1" }, model: { model: "gateway-model", config: { reasoning_effort: "high" } } }).pipe(Layer.provide(FetchHttpClient.layer))
    const run = (prompt: Prompt.RawInput, tools = toolkit) => Effect.runPromise(collectResponse(prompt, tools, undefined, { type: "json", objectName: "answer", schema: Schema.Struct({ answer: Schema.String }) }).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch)))
    const first = await run("Read")
    expect(first.parts.filter((part) => part.type === "tool-call").map((part) => part.id)).toEqual(["a", "c"])
    expect(first.parts.find((part) => part.type === "error")?.error).toMatchObject({ _tag: "ToolCallValidationError", id: "b", params: { path: 123 } })
    expect(first.parts.find((part) => part.type === "finish")).toMatchObject({ usage: { inputTokens: { total: 10, cacheRead: 3 }, outputTokens: { total: 5, reasoning: 2 } }, metadata: { openai: { usage } } })
    const restored = Schema.decodeUnknownSync(Prompt.Prompt)(JSON.parse(JSON.stringify(first.continuation)))
    await run(Prompt.concat(restored, Prompt.make([{ role: "tool", content: ["a", "b", "c"].map((id) => ({ type: "tool-result" as const, id, name: "read", result: id === "b" ? "Invalid path" : "contents", isFailure: id === "b" })) }])))
    const assistant = requests[1]?.messages.filter((message) => message.role === "assistant")
    expect(assistant).toHaveLength(1)
    expect(assistant?.[0]).toMatchObject({ [field]: "Check the files.", content: "Reading.", tool_calls: ["a", "b", "c"].map((id) => ({ id })) })
    expect(requests[0]?.reasoning_effort).toBe("high")
    expect(requests[0]?.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "answer" } })
    const failure = await Effect.runPromise(collectResponse("Read", Toolkit.make(Tool.make("read", { parameters: Schema.Struct({ path: Schema.String }) }))).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.result))
    expect(Result.isFailure(failure)).toBe(true)
  })
}

test("compat: host fails truncated JSON once and retains usage", async () => {
  const limits: number[] = []
  const prompts: unknown[] = []
  const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-key")
    const body = JSON.parse(await new Response(init?.body).text())
    limits.push(body.max_tokens)
    prompts.push(body.messages)
    return new Response(frames("reasoning_content", limits.length === 1), { headers: { "content-type": "text/event-stream" } })
  }, { preconnect: globalThis.fetch.preconnect })
  const reference = { provider: "gateway", model_id: "gateway-model" }
  const binding = modelLayer({ model: { default: reference, allow: "*", providers: { gateway: { baseUrl: "https://fixture.invalid/v1", protocol: "openai-chat-completions", env: ["KEY"] } } }, modelCredentials: { KEY: "private-key" } }, { snapshot: { source: "models.dev", revision: "r1", refreshedAt: 1, status: "fresh", providers: [{ id: "gateway", name: "Gateway", env: [], models: [{ id: "gateway-model", metadata: { contextWindowTokens: 200000, maxOutputTokens: 150 } }] }] } }, { configure: () => ({ reportedCostUsd: (finish) => { const cost = finish.metadata.openai?.usage?.cost; return typeof cost === "number" ? cost : undefined }, compat: { max_output_tokens: 200 }, retry: { backoffMs: [] } }) })
  const action = await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* inferenceClient
    expect(infer.resolve?.().model).toEqual(reference)
    return yield* infer.react({ model: reference, identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] })
  }).pipe(Effect.provide(binding), Effect.provideService(FetchHttpClient.Fetch, fetch)))
  expect(limits).toEqual([150])
  expect(prompts).toHaveLength(1)
  expect(action).toMatchObject({ kind: "fail", error: { reason: { _tag: "UnknownError" } }, failure: { cause: "output_limit", attempts: 1 }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }, reportedCostUsd: 0.25 })
  expect(action).not.toHaveProperty("calls")
  expect(action).not.toHaveProperty("continuation")
})

test("compat interleaving preserves complete arguments and reasoning across byte boundaries", async () => {
  const fc = await import("fast-check")
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 41 }), fc.integer({ min: 1, max: 20 }), async (bytesPerChunk, split) => {
    const argumentsJson = JSON.stringify({ path: "café/資料.txt" })
    const delta = (value: object) => ({ choices: [{ index: 0, delta: value }] })
    const events = [
      delta({ reasoning_content: "Think", tool_calls: [] }),
      delta({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "read", arguments: argumentsJson.slice(0, split) } }] }),
      delta({ content: "Reading" }),
      delta({ reasoning_content: " carefully", tool_calls: [] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(split) } }] }),
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage }
    ]
    const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify({ id: "r", model: "gateway-model", created: 1, ...event })}\n\n`).join("") + "data: [DONE]\n\n")
    let offset = 0
    const fetch = Object.assign(async () => new Response(new ReadableStream({ pull(controller) {
      if (offset >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.slice(offset, offset + bytesPerChunk)); offset += bytesPerChunk
    } }), { headers: { "content-type": "text/event-stream" } }), { preconnect: globalThis.fetch.preconnect })
    const layer = providerLayer({ provider: "openai-compat", client: { apiUrl: "https://fixture.invalid" }, model: { model: "gateway-model" } }).pipe(Layer.provide(FetchHttpClient.layer))
    const result = await Effect.runPromise(collectResponse("Read", toolkit).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch)))
    expect(result.parts.filter((part) => part.type === "tool-call")).toMatchObject([{ id: "a", params: { path: "café/資料.txt" } }])
    expect(result.parts.flatMap((part) => part.type === "reasoning-delta" ? [part.delta] : []).join("")).toBe("Think carefully")
    expect(result.parts.flatMap((part) => part.type === "text-delta" ? [part.delta] : []).join("")).toBe("Reading")
  }), { numRuns: 20 })
})
