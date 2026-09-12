import { inferenceClient } from "@clavia/tardigrade-agent/testing/inference"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

import { modelConfigOf, canonicalModelConfig, type ModelProviderConfig } from "../config"
import { modelLayer } from "../host"
import { protocolOptionsOf } from "./options"
import { providerEvents } from "../testing/fixtures"

const cases = [
  { protocol: "openai-responses", options: { reasoning: { effort: "high" } } },
  { protocol: "anthropic-messages", options: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } },
  { protocol: "openai-chat-completions", options: { reasoning_effort: "high" } },
  { protocol: "bedrock-converse", options: { additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 1024 } } } }
] as const

for (const entry of cases) {
  test(`${entry.protocol}: model options parse without inventing defaults`, () => {
    expect(protocolOptionsOf(entry.protocol, undefined)).toEqual({ protocol: entry.protocol })
    expect(protocolOptionsOf(entry.protocol, {})).toEqual({ protocol: entry.protocol, options: {} })
    expect(protocolOptionsOf(entry.protocol, entry.options)).toEqual(entry)
    expect(() => protocolOptionsOf(entry.protocol, { unknown: true })).toThrow()
    const reference = { provider: "private", model_id: "fixture" }
    const config = modelConfigOf({ default: reference, allow: "*", providers: { private: { baseUrl: "https://fixture.invalid", protocol: entry.protocol, env: ["KEY"], ...(entry.protocol === "bedrock-converse" ? { region: "us-east-1" } : {}), models: { fixture: { options: entry.options } } } } })
    expect(config.providers.private?.models?.fixture?.options).toEqual(entry.options)
    expect(modelConfigOf(JSON.parse(canonicalModelConfig(config)))).toEqual(config)
  })
  if (entry.protocol === "bedrock-converse") continue
  for (const configured of [false, true, "override"] as const) test(`${entry.protocol}: host sends ${configured === "override" ? "overridden" : configured ? "configured" : "absent"} options`, async () => {
    const reference = { provider: "private", model_id: "fixture" }
    const config = modelConfigOf({ default: reference, allow: "*", providers: { private: { baseUrl: "https://fixture.invalid", protocol: entry.protocol, env: ["KEY"], models: { fixture: configured ? { options: entry.options } : {}, unused: { options: entry.options } } } } })
    let requests = 0
    const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requests++
      const body = JSON.parse(await new Response(init?.body).text())
      for (const key of Object.keys(entry.options)) {
        if (configured === "override") expect(body[key]).toEqual(key === "thinking" ? { type: "disabled" } : key === "reasoning_effort" ? "low" : { effort: "low" })
        else if (configured) expect(body[key]).toEqual(entry.options[key as keyof typeof entry.options])
        else expect(body[key]).toBeUndefined()
      }
      const stream = entry.protocol === "openai-chat-completions"
        ? 'data: {"id":"c","created":1,"model":"fixture","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        : providerEvents(entry.protocol === "openai-responses" ? "openai" : "anthropic", false).map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join("")
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    }, { preconnect: globalThis.fetch.preconnect })
    const catalog = { snapshot: { source: "models.dev" as const, revision: "r1", refreshedAt: 1, status: "fresh" as const, providers: [{ id: "private", name: "Private", env: [], models: [{ id: "fixture", metadata: { contextWindowTokens: 200000 } }] }] } }
    const result = await Effect.runPromise(Effect.gen(function* () {
      const infer = yield* inferenceClient
      return yield* infer.react({ model: reference, identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] })
    }).pipe(Effect.provide(modelLayer({ model: config, modelCredentials: { KEY: "fixture" } }, catalog, { configure: () => ({ retry: { backoffMs: [] }, ...(configured === "override" ? { openai: { reasoning: { effort: "low" as const } }, compat: { reasoning_effort: "low" }, anthropic: { thinking: { type: "disabled" as const }, output_config: { effort: "low" as const } } } : {}) }) })), Effect.provideService(FetchHttpClient.Fetch, fetch)))
    expect(result.kind).not.toBe("fail")
    expect(requests).toBe(1)
  })
}

test("reasoning rejects wrong protocols and invalid native fields", () => {
  expect(() => protocolOptionsOf("openai-responses", { thinking: { type: "adaptive" } })).toThrow()
  expect(() => protocolOptionsOf("anthropic-messages", { thinking: { type: "enabled", budget_tokens: 1 } })).toThrow()
  expect(() => protocolOptionsOf("anthropic-messages", { output_config: { effort: "max" } })).toThrow()
  expect(() => protocolOptionsOf("openai-responses", { reasoning: { effort: "invented" } })).toThrow()
  expect(() => protocolOptionsOf("openai-responses", { reasoning: { unexpected: true } })).toThrow()
})

const typedProvider: ModelProviderConfig = { baseUrl: "https://fixture.invalid", env: ["KEY"], protocol: "anthropic-messages", models: { fixture: { options: { thinking: { type: "adaptive" } } } } }
// @ts-expect-error ModelProviderConfig rejects options from a different protocol.
const invalidProvider: ModelProviderConfig = { baseUrl: "https://fixture.invalid", env: ["KEY"], protocol: "anthropic-messages", models: { fixture: { options: { reasoning: { effort: "high" } } } } }
test("provider types associate options with their protocol", () => { expect(typedProvider.protocol).toBe("anthropic-messages"); expect(invalidProvider).toBeDefined() })
