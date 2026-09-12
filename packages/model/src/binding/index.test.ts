import { inferenceClient } from "@clavia/tardigrade-agent/testing/inference"
import { durableReact } from "../testing/durable-inference"
import type { ProviderContinuation } from "@clavia/tardigrade-agent/inference/continuation"
import { TestClock } from "effect/testing"
import { expect, test } from "bun:test"
import { Effect, Fiber, Layer, Redacted, Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { FetchHttpClient } from "effect/unstable/http"
import { actor } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { createHost } from "@clavia/tardigrade-host/host"
import { agentMethods, infer, tool, outputValidateOnce } from "@clavia/tardigrade-agent"
import { ModelReturned } from "@clavia/tardigrade-agent/log/events"

import { inferenceLayer } from "./index"
import { providerEvents } from "../testing/fixtures"

for (const provider of ["openai", "anthropic"] as const) {
  for (const outputCase of ["none", "valid", "invalid", "native", "native-invalid"] as const) {
  const declaredOutput = outputCase !== "none"
  for (const broken of [false, true]) {
  test(`${provider}: durable calls and replay (broken stream: ${broken}, output contract: ${outputCase})`, async () => {
    const result = declaredOutput ? JSON.stringify({ answer: outputCase.endsWith("invalid") ? 123 : "done" }) : "done"
    const requests: unknown[] = []
    const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requests.push(JSON.parse(await new Response(init?.body).text()))
      let events = requests.length === 1 ? providerEvents(provider, true) : provider === "openai" ? [
        { type: "response.output_item.added", output_index: 0, item: { id: "text", type: "message", status: "completed", role: "assistant", content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "text", delta: result },
        { type: "response.output_item.done", output_index: 0, item: { id: "text", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: result, annotations: [] }] } },
        { type: "response.completed", response: { id: "response2", created_at: 1, model: "gpt-5", output: [], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }
      ] : [
        providerEvents(provider, false)[0],
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: result } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null } },
        { type: "message_stop" }
      ]
      if (broken) events = [...providerEvents(provider, true).slice(0, -2), provider === "openai" ? { type: "response.completed", response: {} } : { type: "message_delta", delta: {}, usage: {} }] as typeof events
      return new Response(events.map((event, sequence_number) => `event: ${event?.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    }, { preconnect: globalThis.fetch.preconnect })
    const options = provider === "openai"
      ? { provider, endpoint: "https://fixture.invalid/v1", client: { apiKey: Redacted.make("test"), apiUrl: "https://fixture.invalid/v1" }, model: { model: "gpt-5", config: { store: false } } } as const
      : { provider, endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test"), apiUrl: "https://fixture.invalid" }, model: { model: "claude-sonnet-4-5", config: { max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 1024 } } } } as const
    const executions: string[] = []
    let readHistory: () => ReadonlyArray<Event> = () => []
    const assembled = actor({ name: "effect-agent", methods: agentMethods, components: [infer([outputValidateOnce, tool({
      spec: { name: "read", description: "Read file", inputSchema: { type: "object", properties: { path: { type: "string", pattern: "^[a-z]+$" } }, required: ["path"], additionalProperties: false } },
      run: (_args, context) => Effect.sync(() => { expect(readHistory().some((event) => event.type === "ModelReturned")).toBe(true); expect(readHistory().some((event) => event.type === "ToolReturned" && event.callId === "b")).toBe(true); executions.push(context.callId); return "contents" })
    })], { models: { default: { provider, model_id: options.model.model }, allow: "*" } })] })
    const makeHost = () => createHost({ actorName: "effect-agent", actorFor: () => assembled, layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, inferenceLayer({ ...options, pricing: { promptUsdPerToken: 0.01, completionUsdPerToken: 0.02, cachedPromptUsdPerToken: 0.001, cacheWritePromptUsdPerToken: 0.015 }, retry: { backoffMs: [] }, ...(outputCase.startsWith("native") ? { output: { guarantee: "native", withTools: true } as const } : {}) }).pipe(
      Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
    )) })
    const host = makeHost()
    readHistory = () => host.read("root")
    await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "Read three files", ...(declaredOutput ? { output: { name: "answer", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } } : {}), at: 1 })
    await host.drive()
    const history = host.read("root")
    if (broken) {
      expect(executions).toEqual([])
      expect(history.filter((event) => event.type === "ToolCalled")).toEqual([])
      expect(history.filter((event) => event.type === "ModelReturned")).toMatchObject([{ outcome: "failed" }])
      expect(history.some((event) => event.type === "TurnFailed")).toBe(true)
      return
    }
    if (outputCase.endsWith("invalid")) {
      expect(executions.sort()).toEqual(["a", "c"])
      expect(history.some((event) => event.type === "TurnCompleted")).toBe(false)
      expect(history.filter((event) => event.type === "TurnFailed")).toMatchObject([{ cause: outputCase === "native-invalid" ? "output_contract_violation" : "output_validation_failed" }])
      return
    }
    expect(history.filter((event) => event.type === "TurnFailed")).toEqual([])
    expect(executions.sort()).toEqual(["a", "c"])
    expect(history.filter((event) => event.type === "ToolReturned" && event.callId === "b")).toMatchObject([{ result: { error: expect.stringContaining("Expected string") } }])
    expect(history.some((event) => event.type === "TurnCompleted")).toBe(true)
    const responseIndex = history.findIndex((event) => event.type === "ModelReturned")
    const settledB = history.findIndex((event) => event.type === "ToolReturned" && event.callId === "b")
    expect(settledB).toBeGreaterThan(responseIndex)
    if (outputCase.startsWith("native")) {
      for (const request of requests) expect(request).toMatchObject(provider === "openai"
        ? { text: { format: { type: "json_schema", name: "answer", strict: true, schema: { type: "object", properties: { answer: { type: "string" } } } } } }
        : { output_config: { format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } } } } } })
    }
    if (declaredOutput) {
      expect(history.filter((event) => event.type === "ToolCalled" || event.type === "TurnCompleted").every((event) => event.mode !== undefined)).toBe(true)
      expect(history.find((event) => event.type === "TurnCompleted")).toMatchObject({ output: result })
      expect(JSON.stringify(requests[0])).toContain("answer")
    }
    expect(history[responseIndex]?.usage).toMatchObject({ inputTokens: { total: 10 }, outputTokens: { total: 5 } })
    expect(history.filter((event) => event.type === "ToolCalled" || event.type === "ToolReturned").every((event) => event.usage === undefined)).toBe(true)
    expect(history[responseIndex]?.continuation).toMatchObject({ format: "effect-prompt" })
    expect(JSON.stringify(requests[1])).toContain(provider === "openai" ? "opaque-b" : "opaque")
    expect(JSON.stringify(requests[1])).toContain("Expected string")
    if (provider === "anthropic") expect(JSON.stringify(requests[1])).toContain('"is_error":true')

    const callEnd = history.findLastIndex((event) => event.type === "ToolCalled")
    const saved: Event[] = JSON.parse(JSON.stringify(history.slice(0, Math.max(callEnd, settledB) + 1)))
    executions.length = 0
    const resumed = makeHost()
    readHistory = () => resumed.read("root")
    resumed.seed("root", saved)
    await resumed.wake("root")
    await resumed.drive()
    expect(executions.sort()).toEqual(["a", "c"])
    expect(resumed.read("root").filter((event) => event.type === "ToolReturned" && event.callId === "b")).toHaveLength(1)
    expect(resumed.read("root").some((event) => event.type === "TurnCompleted")).toBe(true)
    expect(resumed.read("root").filter((event) => event.type === "ModelReturned")).toHaveLength(2)
    expect(resumed.read("root").find((event) => event.type === "ModelReturned")?.usage).toEqual(history[responseIndex]?.usage)
    expect(JSON.stringify(requests.at(-1))).toContain(provider === "openai" ? "opaque-b" : "opaque")
    if (outputCase === "none") {
      for (const changed of ["provider", "protocol", "model", "endpoint"] as const) {
        const switched = saved.map((event) => event.continuation === undefined ? event : {
          ...event, continuation: { ...event.continuation as ProviderContinuation, [changed]: "different" }
        })
        const before = JSON.stringify(switched)
        const next = makeHost()
        readHistory = () => next.read("root")
        next.seed("root", switched)
        await next.wake("root")
        await next.drive()
        expect(next.read("root").some((event) => event.type === "TurnCompleted")).toBe(true)
        const wire = JSON.stringify(requests.at(-1))
        expect(wire).toContain("Check")
        expect(wire).toContain("contents")
        if (changed === "endpoint") expect(wire).toContain(provider === "openai" ? "opaque-b" : "opaque")
        else {
          expect(wire).not.toContain(provider === "openai" ? "opaque-b" : "opaque")
          expect(wire).not.toContain('"signature"')
          expect(wire).not.toContain('"type":"reasoning"')
        }
        expect(JSON.stringify(switched)).toBe(before)
      }
    }
  })
}

}

}

for (const provider of ["openai", "anthropic"] as const) {
  test.each([undefined, { guarantee: "none" as const }])(`${provider}: native-only output fails before HTTP (%j)`, async (output) => {
    let requests = 0
    const fetch = Object.assign(async () => { requests += 1; throw new Error("Unexpected request") }, { preconnect: globalThis.fetch.preconnect })
    const layer = inferenceLayer({ provider, endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, model: { model: "fixture" }, ...(output === undefined ? {} : { output }) }).pipe(
      Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
    )
    const action = await Effect.runPromise(Effect.gen(function* () {
      const infer = yield* inferenceClient
      return yield* infer.react({
        identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Answer", tools: [],
        trajectory: [{ type: "MessageReceived", id: "m1", text: "Answer", at: 1, output: { name: "answer", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } }]
      })
    }).pipe(Effect.provide(layer)))
    expect(JSON.parse(JSON.stringify(action))).toMatchObject({
      kind: "fail", endpoint: { provider, model: "fixture" },
      failure: { cause: "output_unsupported", attempts: 0, policy: { provider, model: "fixture", ...(output === undefined ? {} : { output }) } }
    })
    expect(requests).toBe(0)
  })
}

for (const provider of ["openai", "anthropic"] as const) {
  for (const failure of ["rate-limit", "partial-stream"] as const) {
    test(`${provider}: retries ${failure} as a fresh complete attempt`, async () => {
      let requests = 0
      const attempts = new Set<string>()
      const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        requests++
        expect((init as RequestInit & { timeout?: boolean }).timeout).toBe(false)
        if (requests === 1 && failure === "rate-limit") return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Try again" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } })
        let events = providerEvents(provider, false)
        if (requests === 1) events = [...events.slice(0, -2), provider === "openai" ? { type: "response.completed", response: {} } : { type: "message_delta", delta: {}, usage: {} }] as typeof events
        const chunks = events.map((event, sequence_number) => new TextEncoder().encode(`event: ${event?.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`))
        return new Response(new ReadableStream({ pull(controller) { const chunk = chunks.shift(); if (chunk === undefined) controller.close(); else controller.enqueue(chunk) } }), { headers: { "content-type": "text/event-stream" } })
      }, { preconnect: globalThis.fetch.preconnect })
      const binding = inferenceLayer({ provider, endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, model: { model: provider === "openai" ? "gpt-5" : "claude-sonnet-4-5" }, retry: { backoffMs: [0], retryAfterJitterMs: 0 } }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
      const action = await Effect.runPromise(Effect.gen(function* () {
        const infer = yield* inferenceClient
        return yield* durableReact(infer, { identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [{ type: "MessageReceived", id: "m1", text: "Read", at: 1 }], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string", pattern: "^[a-z]+$" } }, required: ["path"], additionalProperties: false } }] }, "attempt", undefined, (delta) => attempts.add(delta.physicalAttempt))
      }).pipe(Effect.provide(binding)))
      expect(requests).toBe(2)
      expect(action).toMatchObject({ kind: "calls", calls: [{ callId: "a" }, { callId: "b" }, { callId: "c" }] })
      expect(attempts.size).toBe(failure === "partial-stream" ? 2 : 1)
    })
  }
}

test("request deadline aborts one physical request and reports retryability", async () => {
  let requests = 0
  let aborted = 0
  const fetch = Object.assign((_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    requests++
    init?.signal?.addEventListener("abort", () => { aborted++; reject(new Error("aborted")) }, { once: true })
  }), { preconnect: globalThis.fetch.preconnect })
  const binding = inferenceLayer({ provider: "openai", endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, model: { model: "gpt-5" }, timeout: { firstChunkMs: 10, idleMs: 100, attemptMs: 100 }, retry: { backoffMs: [0] } }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const action = await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* inferenceClient
    const fiber = yield* infer.react({ identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Answer", tools: [], trajectory: [] }).pipe(Effect.forkChild)
    yield* TestClock.adjust(20)
    return yield* Fiber.join(fiber)
  }).pipe(Effect.provide(Layer.merge(binding, TestClock.layer()))))
  expect(requests).toBe(1)
  expect(aborted).toBe(1)
  expect(action).toMatchObject({ kind: "fail", retryable: true, failure: { attempts: 1 } })
  expect(action).not.toHaveProperty("failure.policy")
})

test("pre-cancelled inference sends nothing and the next request succeeds", async () => {
  let requests = 0
  const fetch = Object.assign(async () => {
    requests++
    return new Response(providerEvents("openai", false).map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  }, { preconnect: globalThis.fetch.preconnect })
  const layer = inferenceLayer({ provider: "openai", endpoint: "https://fixture.invalid", client: { apiUrl: "https://fixture.invalid" }, model: { model: "gpt-5" }, retry: { backoffMs: [] } }).pipe(Layer.provide(FetchHttpClient.layer))
  const request = { identity: { actor: "test", instance: "main", thread: "root", turn: "m" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string", pattern: "^[a-z]+$" } }, required: ["path"], additionalProperties: false } }] }
  await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* inferenceClient
    const stopped = yield* infer.react(request, "cancelled", AbortSignal.abort()).pipe(Effect.exit)
    expect(stopped._tag).toBe("Failure")
    expect(requests).toBe(0)
    expect(yield* infer.react(request, "next")).toMatchObject({ kind: "calls" })
    expect(requests).toBe(1)
  }).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch)))
})

for (const outcome of ["stop", "tool_calls", "content_filter", "length", "interrupted", "rate-limit"] as const) {
  test(`response evidence survives ${outcome} and durable encoding`, async () => {
    const fetch = Object.assign(async () => {
      if (outcome === "rate-limit") return new Response(JSON.stringify({ error: { message: "Try later", type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json" } })
      const chunks = [
        { id: "reported-id", model: "served-model", created: 1, choices: [{ index: 0, delta: { content: "Partial", reasoning_content: "Thinking" }, finish_reason: null }] },
        ...(outcome === "interrupted" ? [] : [{ id: "reported-id", model: "served-model", created: 1, choices: [{ index: 0, delta: outcome === "tool_calls" ? { tool_calls: [{ index: 0, id: "A", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] } : {}, finish_reason: outcome }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }])
      ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (outcome === "interrupted" ? "" : "data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } })
    }, { preconnect: globalThis.fetch.preconnect })
    const binding = inferenceLayer({ provider: "openai-compat", providerId: "gateway", endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, model: { model: "requested-model" }, retry: { backoffMs: [] } }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
    const definition = actor({ name: "evidence", methods: agentMethods, components: [infer([outputValidateOnce, tool({ spec: { name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }, run: () => Effect.succeed("done") })], { models: { default: { provider: "gateway", model_id: "requested-model" }, allow: "*" } })] })
    const host = createHost({ actorName: "evidence", actorFor: () => definition, layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, binding) })
    await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "Read", budget: 1, at: 1 })
    await host.drive()
    const recorded = host.read("root").find((event) => event.type === "ModelReturned")!
    const event = Schema.decodeUnknownSync(ModelReturned)(JSON.parse(JSON.stringify(recorded)))
    expect(event.endpoint).toMatchObject({ provider: "gateway", model: "requested-model" })
    if (outcome === "rate-limit") {
      expect(event.response).toBeUndefined()
      expect(event.error).toMatchObject({ _tag: "AiError", reason: { _tag: "RateLimitError", http: { response: { status: 429 } } } })
      return
    }
    expect(event.response).toMatchObject({ id: "reported-id", modelId: "served-model" })
    expect(event.reasoning).toBe("Thinking")
    if (outcome === "stop" || outcome === "tool_calls") {
      expect(event.outcome).toBe("returned")
      expect(event.finish?.reason).toBe(outcome === "stop" ? "stop" : "tool-calls")
    } else {
      expect(event.outcome).toBe("failed")
      expect(event.text).toBe("Partial")
      expect(host.read("root").filter((event) => event.type === "ToolCalled")).toEqual([])
      expect(event.finish?.reason).toBe(outcome === "interrupted" ? undefined : outcome === "length" ? "length" : "content-filter")
      if (outcome !== "interrupted") {
        expect(event.usage).toMatchObject({ inputTokens: { total: 10 }, outputTokens: { total: 3 } })
        expect(host.read("root").find((event) => event.type === "TurnFailed")).toMatchObject({ cause: outcome === "length" ? "output_limit" : "refused" })
      }
    }
  })
}

test.each([1, 2])("%i provider error parts retain their JSON structure without a finish part", async (count) => {
  const error = { type: "error", code: "server_error", message: "Try later", param: null, sequence_number: 1 }
  const fetch = Object.assign(async () => new Response(Array.from({ length: count }, () => `event: error\ndata: ${JSON.stringify(error)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }), { preconnect: globalThis.fetch.preconnect })
  const binding = inferenceLayer({ provider: "openai", endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, model: { model: "gpt-5" }, retry: { backoffMs: [] } }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const action = await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* inferenceClient
    return yield* infer.react({ identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Hello", trajectory: [], tools: [] })
  }).pipe(Effect.provide(binding)))
  const item = { reason: { metadata: { tardigrade: { evidence: error } } } }
  expect(action).toMatchObject({ kind: "fail", error: count === 1 ? item : { reason: { metadata: { tardigrade: { evidence: [item, item] } } } } })
  expect(action.response).toBeUndefined()
})

test("a retry does not inherit the preceding response identity or partial output", async () => {
  let requests = 0
  const fetch = Object.assign(async () => {
    if (++requests === 2) return new Response(JSON.stringify({ error: { message: "Denied" } }), { status: 400, headers: { "content-type": "application/json" } })
    return new Response(`data: ${JSON.stringify({ id: "old-id", model: "old-model", created: 1, choices: [{ index: 0, delta: { content: "old-text" }, finish_reason: null }] })}\n\n`, { headers: { "content-type": "text/event-stream" } })
  }, { preconnect: globalThis.fetch.preconnect })
  const binding = inferenceLayer({ provider: "openai-compat", endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, model: { model: "requested" }, retry: { backoffMs: [0], retryAfterJitterMs: 0 } }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const action = await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* inferenceClient
    return yield* durableReact(infer, { identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Hello", trajectory: [], tools: [] })
  }).pipe(Effect.provide(binding)))
  expect(requests).toBe(2)
  expect(action).toMatchObject({ kind: "fail", error: { reason: { _tag: "InvalidRequestError", http: { response: { status: 400 } } } } })
  expect(action).not.toHaveProperty("text")
  expect(action).not.toHaveProperty("response")
})
