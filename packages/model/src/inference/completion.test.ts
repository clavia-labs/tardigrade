import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Infer } from "@clavia/tardigrade-agent"
import { providerEvents } from "../testing/fixtures"
import { inferenceLayer } from "./binding"

for (const terminal of ["eof", "done", "complete", "recovered"] as const) {
  for (const tool of [false, true]) {
    test(`compat requires provider completion (terminal: ${terminal}, tool: ${tool})`, async () => {
      let requests = 0
      const fetch = Object.assign(async () => {
        requests++
        const finished = terminal === "complete" || terminal === "recovered" && requests > 1
        const delta = tool ? { tool_calls: [{ index: 0, id: finished ? "a" : "stale", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] } : { content: finished ? "fresh" : "partial" }
        const chunks = [ { id: "r", model: "fixture", created: 1, choices: [{ index: 0, delta, finish_reason: null }] }, ...(finished ? [{ id: "r", model: "fixture", created: 1, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] }] : []) ]
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (terminal === "eof" ? "" : "data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } })
      }, { preconnect: globalThis.fetch.preconnect })
      const layer = inferenceLayer({ provider: "openai-compat", endpoint: "https://fixture.invalid", client: { apiUrl: "https://fixture.invalid" }, model: { model: "fixture" }, throttleRetryDelaysMs: [0], retryAfterJitterMs: 0 }).pipe(Layer.provide(FetchHttpClient.layer))
      const result = await Effect.runPromise(Effect.flatMap(Infer, (infer) => infer.react({ identity: { actor: "test", instance: "main", thread: "root", turn: "t" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] })).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch)))
      if (terminal === "complete" || terminal === "recovered") {
        expect(requests).toBe(terminal === "complete" ? 1 : 2)
        expect(result.kind).toBe(tool ? "calls" : "complete")
        expect(JSON.stringify(result)).not.toContain("stale")
        if (!tool) expect(result).toMatchObject({ output: "fresh" })
      } else {
        expect(result).toMatchObject({ kind: "fail", failure: { attempts: 2 } })
        expect(requests).toBe(2)
        expect(result).not.toHaveProperty("calls")
        expect(result).not.toHaveProperty("continuation")
      }
    })
  }
}

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider}: early EOF retries before exposing calls`, async () => {
    let requests = 0
    const fetch = Object.assign(async () => {
      requests++
      const events = providerEvents(provider, false)
      const response = requests === 1 ? events.slice(0, -2) : events
      return new Response(response.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    }, { preconnect: globalThis.fetch.preconnect })
    const layer = inferenceLayer({ provider, endpoint: "https://fixture.invalid", client: { apiUrl: "https://fixture.invalid" }, model: { model: "fixture" }, throttleRetryDelaysMs: [0], retryAfterJitterMs: 0 }).pipe(Layer.provide(FetchHttpClient.layer))
    const result = await Effect.runPromise(Effect.flatMap(Infer, (infer) => infer.react({ identity: { actor: "test", instance: "main", thread: "root", turn: "t" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] })).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch)))
    expect(requests).toBe(2)
    expect(result).toMatchObject({ kind: "calls", calls: [{ callId: "a" }, { callId: "b" }, { callId: "c" }] })
  })
}
