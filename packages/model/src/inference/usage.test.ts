import { expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { Response as AiResponse } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { Infer } from "@clavia/tardigrade-agent/inference/contract"
import { responseUsageOf } from "./usage"
import { inferenceLayer } from "./binding"
import { providerEvents } from "../testing/fixtures"

const pricing = { promptUsdPerToken: 1, completionUsdPerToken: 3, cachedPromptUsdPerToken: 0.1, cacheWritePromptUsdPerToken: 2 }
const stamp = { provider: "openai", model: "fixture" }
const finish = (reportedCost?: number, missing = false) => AiResponse.makePart("finish", {
  reason: "stop",
  usage: { inputTokens: missing ? {} : { total: 20, uncached: 14, cacheRead: 4, cacheWrite: 2 }, outputTokens: missing ? {} : { total: 10, reasoning: 3 } },
  metadata: reportedCost === undefined ? {} : { openai: { usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, cost: reportedCost, extra_metric: "preserved" } } }
})

test("prices cache buckets without charging reasoning twice", () => {
  expect(responseUsageOf(finish(), stamp, pricing)).toMatchObject({ promptTokens: 20, completionTokens: 10, totalTokens: 30, cachedPromptTokens: 4, cacheWritePromptTokens: 2, reasoningTokens: 3, estimatedCostUsd: 48.4, costUsd: 48.4, costSource: "table" })
  expect(responseUsageOf(finish(), stamp, { promptUsdPerToken: 1, completionUsdPerToken: 3 }).costUsd).toBeUndefined()
})

test("retains provider bills including zero alongside estimates", () => {
  for (const bill of [0, 7]) expect(responseUsageOf(finish(bill), stamp, pricing, bill)).toMatchObject({ costUsd: bill, costSource: "provider", reportedCostUsd: bill, estimatedCostUsd: 48.4, providerReports: [{ providerSpecific: { metadata: { openai: { usage: { extra_metric: "preserved" } } } } }] })
})

test("missing token totals do not become a zero-cost estimate", () => {
  const usage = responseUsageOf(finish(undefined, true), stamp, pricing)
  expect(usage.costUsd).toBeUndefined()
  expect(usage.estimatedCostUsd).toBeUndefined()
  expect(usage.totalTokens).toBeUndefined()
  expect(usage.promptTokens).toBeUndefined()
  expect(usage.completionTokens).toBeUndefined()
  expect(usage.providerReports).toHaveLength(1)
  expect(responseUsageOf(finish(7, true), stamp, pricing, 7)).toMatchObject({ reportedCostUsd: 7, costUsd: 7 })
})

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
    const binding = inferenceLayer({ provider: "openai", endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, model: { model: "gpt-5" }, maxOutputTokens: 100, reportedCostUsd: (finish) => { const cost = finish.metadata.openai?.usage?.cost; return typeof cost === "number" ? cost : undefined }, pricing, throttleRetryDelaysMs: outcome === "exhausted" ? [] : [0] }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
    const action = await Effect.runPromise(Effect.gen(function* () {
      const infer = yield* Infer
      return yield* infer.react({ identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] })
    }).pipe(Effect.provide(binding)))
    const copies = 1
    expect(requests).toBe(outcome === "unreported-retry" ? 2 : 1)
    expect(action.kind).toBe(["refused", "truncated", "exhausted"].includes(outcome) ? "fail" : "calls")
    if (outcome === "exhausted") {
      expect(action.usage?.costUsd).toBeUndefined()
      expect(action.usage?.providerReports).toBeUndefined()
      return
    }
    expect(action.usage).toMatchObject({ ...(outcome === "unreported-retry" ? {} : { promptTokens: 10 * copies, completionTokens: 5 * copies }), providerReports: Array.from({ length: copies }, () => ({ providerSpecific: { metadata: { openai: { usage: { custom_metric: "kept" } } } } })) })
    if (outcome === "unreported-retry") {
      expect(action.usage?.costUsd).toBeUndefined()
      expect(action.usage?.promptTokens).toBeUndefined()
      expect(action.usage?.completionTokens).toBeUndefined()
    }
    else {
      expect(action.usage?.reportedCostUsd).toBe(0.25 * copies)
      expect(action.usage?.estimatedCostUsd).toBeCloseTo(24.3 * copies)
      expect(action.usage?.costUsd).toBe(0.25 * copies)
    }
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
  const binding = inferenceLayer({ provider: "anthropic", endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, model: { model: "claude-sonnet-4-5" }, pricing, throttleRetryDelaysMs: [] }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const action = await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* Infer
    return yield* infer.react({ identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] })
  }).pipe(Effect.provide(binding)))
  expect(action.kind).toBe("calls")
  expect(action.usage).toMatchObject({ promptTokens: 15, completionTokens: 5, totalTokens: 20, cachedPromptTokens: 3, cacheWritePromptTokens: 2, estimatedCostUsd: 29.3, providerReports: [{ providerSpecific: { metadata: { anthropic: { usage: { cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } } } }] })
})

for (const example of [
  { name: "Bedrock exclusive cache bucket", usage: { inputTokens: { total: 1780, uncached: 4, cacheWrite: 1776 }, outputTokens: { total: 165 } }, raw: { inputTokens: 4, cacheWriteInputTokens: 1776, outputTokens: 165, totalTokens: 1945 }, expected: { promptTokens: 1780, completionTokens: 165, totalTokens: 1945 } },
  { name: "Chat inclusive input with cache alias", usage: { inputTokens: { total: 2998, uncached: 1958, cacheRead: 1040 }, outputTokens: { total: 449 } }, raw: { prompt_tokens: 2998, completion_tokens: 449, total_tokens: 3447, cache_read_input_tokens: 1040, prompt_tokens_details: { cached_tokens: 1040 } }, expected: { promptTokens: 2998, completionTokens: 449, totalTokens: 3447 } }
]) {
  test(`typed usage ignores raw field heuristics: ${example.name}`, () => {
    const finish = AiResponse.makePart("finish", { reason: "stop", usage: example.usage, metadata: { evidence: example.raw } })
    expect(responseUsageOf(finish, stamp, pricing)).toMatchObject(example.expected)
    expect(responseUsageOf(finish, stamp).providerReports?.[0]?.providerSpecific).toEqual({ usage: finish.usage, metadata: finish.metadata })
  })
}

test("provider cost requires an explicit typed value", () => {
  expect(responseUsageOf(finish(7), stamp, pricing)).toMatchObject({ costUsd: 48.4, costSource: "table" })
  expect(responseUsageOf(finish(7), stamp, pricing).reportedCostUsd).toBeUndefined()
  expect(responseUsageOf(finish(7), stamp, pricing, 7)).toMatchObject({ reportedCostUsd: 7, costUsd: 7, costSource: "provider" })
})
