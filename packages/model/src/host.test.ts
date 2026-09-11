import { expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Infer, type InferDelta } from "@clavia/tardigrade-agent"
import { modelLayer } from "./host"
import { providerEvents } from "./testing/fixtures"

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider}: host selection, native settings, and observer delivery`, async () => {
    const reference = { provider: "private-provider", model_id: provider === "openai" ? "gpt-5" : "claude-sonnet-4-5" }
    const config = { model: { default: reference, allow: "*" as const, providers: {
      [reference.provider]: { baseUrl: "https://fixture.invalid/v1", protocol: provider === "openai" ? "openai-responses" as const : "anthropic-messages" as const, env: ["MODEL_KEY"] }
    } }, modelCredentials: { MODEL_KEY: "private-key" } }
    const catalog = { snapshot: { source: "models.dev" as const, revision: "r1", refreshedAt: 1, status: "fresh" as const, providers: [
      { id: reference.provider, name: "Private", env: [], models: [{ id: reference.model_id, metadata: { contextWindowTokens: 200000, maxOutputTokens: 50, pricing: { promptUsdPerToken: 1, completionUsdPerToken: 2, cachedPromptUsdPerToken: 1 } } }] }
    ] } }
    const observed: InferDelta[] = []
    const direct: InferDelta[] = []
    let requests = 0
    const fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requests++
      expect(String(input)).toContain("https://fixture.invalid/v1/")
      expect(new Headers(init?.headers).get(provider === "openai" ? "authorization" : "x-api-key")).toBe(provider === "openai" ? "Bearer private-key" : "private-key")
      const body = JSON.parse(await new Response(init?.body).text())
      expect(body).toMatchObject(provider === "openai" ? { model: reference.model_id, max_output_tokens: 50, reasoning: { effort: "high" } } : { model: reference.model_id, max_tokens: 50, thinking: { type: "enabled", budget_tokens: 10 } })
      const events = providerEvents(provider, false)
      return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    }, { preconnect: globalThis.fetch.preconnect })
    const binding = modelLayer(config, catalog, {
      configure: () => ({ maxOutputTokens: 1000, throttleRetryDelaysMs: [], ...(provider === "openai" ? { openai: { max_output_tokens: 200, reasoning: { effort: "high" } } } : { anthropic: { max_tokens: 200, thinking: { type: "enabled", budget_tokens: 10 } } }) }),
      observer: { onDelta: (delta) => Effect.sync(() => { observed.push(delta) }) }
    })
    const action = await Effect.runPromise(Effect.gen(function* () {
      const infer = yield* Infer
      const resolution = infer.resolve?.()
      expect(resolution).toMatchObject({ model: reference, contextWindowTokens: 200000, maxOutputTokens: 50, catalogRevision: "r1", models: { allow: [{ provider: reference.provider, model_ids: [reference.model_id] }] } })
      return yield* infer.react({ model: reference, identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] }, "attempt", undefined, (delta) => direct.push(delta))
    }).pipe(Effect.provide(binding), Effect.provideService(FetchHttpClient.Fetch, fetch)))
    expect(requests).toBe(1)
    expect(action).toMatchObject({ kind: "calls", usage: { provider: reference.provider, model: reference.model_id, costUsd: 20 }, continuation: { provider: reference.provider } })
    expect(observed.length).toBeGreaterThan(0)
    expect(observed).toEqual(direct)
    expect(observed.every((delta) => delta.model.provider === reference.provider)).toBe(true)
    expect(JSON.stringify(action)).not.toContain("private-key")

    const denied = modelLayer({ ...config, model: { ...config.model, allow: [] } }, catalog)
    await Effect.runPromise(Effect.gen(function* () {
      const infer = yield* Infer
      expect(() => infer.resolve?.()).toThrow("excluded")
      expect(yield* infer.react({ model: reference, identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [] })).toMatchObject({ kind: "fail", failure: { attempts: 0 } })
    }).pipe(Effect.provide(denied)))
    expect(requests).toBe(1)
  })
}
