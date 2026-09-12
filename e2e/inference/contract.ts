import { providerLayer } from "../../packages/model/src/providers/openai-compat"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { actor } from "tardie/core"
import { agentMethods, infer, tool, outputValidateOnce } from "tardie/agent"
import { modelLayer as configuredModelLayer } from "../../packages/model/src/host"

export const definition = actor({ name: "inference-test", methods: agentMethods, components: [infer([outputValidateOnce, tool({
  spec: { name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  run: (args) => Effect.succeed({ contents: args })
})], { models: { default: { provider: "test", model_id: "fixture" }, allow: "*" } })] })

export const modelLayer = (baseUrl: string) => configuredModelLayer({ model: { default: { provider: "test", model_id: "fixture" }, allow: "*", providers: { test: { baseUrl, protocol: "openai-chat-completions", env: ["KEY"] } } }, modelCredentials: { KEY: "fixture" } }, {
  snapshot: { source: "models.dev", revision: "r", refreshedAt: 1, status: "fresh", providers: [{ id: "test", name: "Test", env: [], models: [{ id: "fixture", metadata: { contextWindowTokens: 10000, maxOutputTokens: 1000 } }] }] }
}, { providerLayer, configure: () => ({ retry: { backoffMs: [0], retryAfterJitterMs: 0 }, maxOutputTokens: 1000 }) })

export const responseFor = (body: string): string => {
  const input = JSON.parse(body) as { messages: Array<{ role: string; content?: string }> }
  const done = input.messages.some((m) => m.role === "tool")
  const broken = input.messages.some((m) => m.content?.includes("broken"))
  const delta = done ? { content: "done" } : { tool_calls: ["a", "b", "c"].map((id, index) => ({ index, id, type: "function", function: { name: "read", arguments: JSON.stringify({ path: id === "b" ? 123 : id }) } })) }
  const chunks = [{ choices: [{ index: 0, delta, finish_reason: null }] }, ...(broken ? [] : [{ choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }])]
  return chunks.map((chunk) => `data: ${JSON.stringify({ id: "r", model: "fixture", created: 1, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n"
}

export type RuntimeFetch = (path: string, init?: RequestInit) => Promise<Response>

export const runContract = async (fetch: RuntimeFetch, scenario: "complete" | "broken" | "retry") => {
  const send = (path: string, method: string, body?: unknown) => fetch(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  assert.equal((await send("/v1/actors/main", "PUT")).status, 200)
  assert.equal((await send("/v1/actors/main/threads", "POST", { name: scenario })).status, 200)
  const path = `/v1/actors/main/threads/${scenario}/methods/message/calls/m1`
  assert.equal((await send(path, "PUT", { text: scenario })).status, 202)
  let state: { status?: string } = {}
  for (let i = 0; i < 200; i++) {
    state = await (await fetch(path)).json() as { status?: string }
    if (state.status !== "pending") break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(state.status, scenario !== "broken" ? "completed" : "failed")
  const rows = await (await fetch(`/v1/actors/main/threads/${scenario}/events`)).json() as Array<{ event: { type: string; callId?: string; isFailure?: boolean; ordinal?: number; outcome?: string } }>
  const events = rows.map((r) => r.event)
  const attempts = events.filter((event) => event.type === "ModelCalled" || event.type === "ModelReturned")
  assert.equal(attempts.length, scenario === "retry" ? 6 : 4)
  for (let index = 0; index < attempts.length; index += 2) {
    const called = attempts[index]!
    const returned = attempts[index + 1]!
    assert.equal(called.type, "ModelCalled")
    assert.equal(returned.type, "ModelReturned")
    assert.equal(called.ordinal, returned.ordinal)
    assert.equal(called.callId, returned.callId)
  }
  if (scenario === "retry") {
    assert.equal(attempts[1]!.outcome, "failed")
    assert.equal(attempts[3]!.outcome, "returned")
    assert.notEqual(attempts[0]!.callId, attempts[2]!.callId)
  }
  const calls = events.filter((e) => e.type === "ToolCalled")
  assert.equal(calls.length, scenario !== "broken" ? 3 : 0)
  if (scenario !== "broken") {
    assert.deepEqual(events.filter((e) => e.type === "ToolReturned" && !e.isFailure).map((e) => e.callId).sort(), ["a", "c"])
    assert.equal(events.filter((e) => e.type === "ToolReturned" && e.callId === "b" && e.isFailure).length, 1)
    assert.ok(events.findIndex((e) => e.type === "ModelReturned") < events.findIndex((e) => e.type === "ToolReturned"))
  }
  return { path, state, events }
}
