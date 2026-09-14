import { inferenceClient } from "@clavia/tardigrade-agent/testing/inference"
import { modelReturned } from "@clavia/tardigrade-agent/log/events"
import { usageIn } from "@clavia/tardigrade-agent/inference/usage"
import { durableReact } from "../../../testing/durable-inference"
import { expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { Event } from "@clavia/tardigrade-core/log/event"

import { inferenceLayer } from "@clavia/tardigrade-model/services"
import { providerEvents } from "@clavia/tardigrade-model/testing/fixtures"

const pricing = { promptUsdPerToken: 1, completionUsdPerToken: 3, cachedPromptUsdPerToken: 0.1, cacheWritePromptUsdPerToken: 2 }

for (const outcome of ["success", "refused", "truncated", "trailing-data", "unreported-retry", "exhausted"] as const) {
  test(`provider accounting survives ${outcome}`, async () => {
    let requests = 0
    const fetch = Object.assign(async () => {
      requests++
      const events: Record<string, unknown>[] = providerEvents("openai", false)
      const end = events.at(-1)!
      const response = end.response as { usage: Record<string, unknown> & { input_tokens_details: Record<string, unknown> }; incomplete_details?: { reason: string } }
      response.usage.cost = 0.25
      response.usage.custom_metric = "kept"
      response.usage.input_tokens_details.cache_write_tokens = 2
      if (outcome === "refused" || outcome === "truncated") {
        end.type = "response.incomplete"
        response.incomplete_details = { reason: outcome === "truncated" ? "max_output_tokens" : "content_filter" }
      }
      if ((outcome === "trailing-data" || outcome === "unreported-retry" || outcome === "exhausted") && requests === 1) {
        if (outcome === "unreported-retry" || outcome === "exhausted") events.pop()
        events.push({ type: "response.completed", response: {} })
      }
      const chunks = events.map((event, sequence_number) => new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`))
      return new Response(new ReadableStream({ pull(controller) { const chunk = chunks.shift(); if (chunk === undefined) controller.close(); else controller.enqueue(chunk) } }), { headers: { "content-type": "text/event-stream" } })
    }, { preconnect: globalThis.fetch.preconnect })
    const binding = inferenceLayer({ provider: "openai", endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, model: { model: "gpt-5" }, maxOutputTokens: 100, reportedCostUsd: (finish) => { const cost = finish.metadata.openai?.usage?.cost; return typeof cost === "number" ? cost : undefined }, pricing, retry: { backoffMs: outcome === "exhausted" ? [] : [0] } }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
    const action = await Effect.runPromise(Effect.gen(function* () {
      const infer = yield* inferenceClient
      return yield* durableReact(infer, { identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] })
    }).pipe(Effect.provide(binding)))
    expect(requests).toBe(outcome === "unreported-retry" ? 2 : 1)
    expect(action.kind).toBe(["refused", "truncated", "exhausted"].includes(outcome) ? "fail" : "calls")
    if (outcome === "exhausted") {
      expect(action.usage).toEqual({ inputTokens: {}, outputTokens: {} })
      expect(action.reportedCostUsd).toBeUndefined()
      return
    }
    expect(action.usage).toMatchObject({ inputTokens: { total: 10 }, outputTokens: { total: 5 } })
    expect(action.finish?.metadata).toMatchObject({ openai: { usage: { custom_metric: "kept" } } })
    expect(action.reportedCostUsd).toBe(0.25)
    expect(action.usage).not.toHaveProperty("costUsd")
    expect(action.usage).not.toHaveProperty("estimatedCostUsd")
    const accounting = usageIn([
      { type: "ModelCalled", callId: "m1/infer/0", ordinal: 0, turn: "m1", pricing, at: 0 } as Event,
      modelReturned({
        callId: "m1/infer/0",
        ordinal: 0,
        turn: "m1",
        outcome: action.kind === "fail" ? "failed" : "returned",
        usage: action.usage ?? {},
        endpoint: action.endpoint,
        ...(action.reportedCostUsd === undefined ? {} : { reportedCostUsd: action.reportedCostUsd }),
        at: 1
      })
    ], "m1")
    expect(accounting).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedPromptTokens: 3,
      cacheWritePromptTokens: 2,
      reasoningTokens: 2,
      reportedCostUsd: 0.25,
      estimatedCostUsd: 24.3,
      costUsd: 0.25,
      costSource: "provider"
    })
  })
}

test("Anthropic cache creation and reads are counted once", async () => {
  const events: Record<string, unknown>[] = providerEvents("anthropic", false)
  const startUsage = (events[0]!.message as { usage: Record<string, unknown> }).usage
  startUsage.cache_read_input_tokens = 3
  startUsage.cache_creation_input_tokens = 2
  const delta = events.find((event) => event.type === "message_delta")!
  const endUsage = delta.usage as Record<string, unknown>
  endUsage.cache_read_input_tokens = 3
  endUsage.cache_creation_input_tokens = 2
  const fetch = Object.assign(async () => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }), { preconnect: globalThis.fetch.preconnect })
  const binding = inferenceLayer({ provider: "anthropic", endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, model: { model: "claude-sonnet-4-5" }, pricing, retry: { backoffMs: [] } }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const action = await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* inferenceClient
    return yield* infer.react({ identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] })
  }).pipe(Effect.provide(binding)))
  expect(action.kind).toBe("calls")
  expect(action.usage).toMatchObject({ inputTokens: { total: 15, cacheRead: 3, cacheWrite: 2 }, outputTokens: { total: 5 } })
  expect(action.finish?.metadata).toMatchObject({ anthropic: { usage: { cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } })
})
