import { expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { OpenAiConfig } from "@tardie/ai-openai"
import { OpenAiConfig as CompatConfig } from "@tardie/ai-openai-compat"
import { AnthropicConfig } from "@tardie/ai-anthropic"
import { Infer } from "@clavia/tardigrade-agent/inference/contract"
import { inferenceLayer } from "./binding"
import { providerEvents } from "../testing/fixtures"

for (const provider of ["openai", "openai-compat", "anthropic"] as const) {
  test(`${provider}: logical keys survive retry and replay without leaking into later calls`, async () => {
    const headers: Headers[] = []
    const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      headers.push(new Headers(init?.headers))
      if (headers.length === 1) return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Retry" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } })
      const body = provider === "openai-compat"
        ? `data: ${JSON.stringify({ id: "r", model: "fixture", created: 1, choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
        : providerEvents(provider, false).map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join("")
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }, { preconnect: globalThis.fetch.preconnect })
    const layer = inferenceLayer({ provider, endpoint: "https://fixture.invalid", client: { apiUrl: "https://fixture.invalid", apiKey: Redacted.make("fixture-key"), transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader("x-client", "kept")) }, model: { model: "fixture" }, throttleRetryDelaysMs: [0], retryAfterJitterMs: 0 }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
    const request = { identity: { actor: "a", instance: "main", thread: "root", turn: "t" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] }
    const scope = provider === "openai" ? OpenAiConfig : provider === "openai-compat" ? CompatConfig : AnthropicConfig
    const run = (key?: string) => Effect.runPromise(Effect.flatMap(Infer, (infer) => infer.react(request, key)).pipe(
      Effect.provide(layer),
      scope.withClientTransform(HttpClient.mapRequest(HttpClientRequest.setHeader("x-scope", "kept")))
    ))
    for (const key of ["t/infer/0", "t/infer/0", "t/infer/1", undefined]) {
      expect((await run(key)).kind).toBe(provider === "openai-compat" ? "complete" : "calls")
    }
    expect(headers.map((header) => header.get("idempotency-key"))).toEqual(["t/infer/0", "t/infer/0", "t/infer/0", "t/infer/1", null])
    const beforeConcurrent = headers.length
    await Effect.runPromise(Effect.flatMap(Infer, (infer) => Effect.all(
      ["parallel-a", "parallel-b"].map((key) => infer.react(request, key)), { concurrency: "unbounded" }
    )).pipe(Effect.provide(layer), scope.withClientTransform(HttpClient.mapRequest(HttpClientRequest.setHeader("x-scope", "kept")))))
    expect(headers.slice(beforeConcurrent).map((header) => header.get("idempotency-key")).sort()).toEqual(["parallel-a", "parallel-b"])
    for (const header of headers) {
      expect(header.get("x-client")).toBe("kept")
      if (provider !== "anthropic") expect(header.get("x-scope")).toBe("kept")
      expect(header.get(provider === "anthropic" ? "x-api-key" : "authorization")).toContain("fixture-key")
    }
  })
}
