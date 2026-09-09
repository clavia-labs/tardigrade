import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Infer, type InferDelta } from "@clavia/tardigrade-agent"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { renderMessages } from "@clavia/tardigrade-agent/projection/messages"
import { modelAdapters, type ModelConfig } from "./adapter"
import { infer } from "./model"
import { anthropicAdapter } from "./anthropic"
import { openAICompatibleAdapter } from "./openai"
import { continuationScopeOf, responseStateOf, withContinuation } from "./continuation"

interface CapturedBody {
  messages: Array<{ role?: string; content: Array<Record<string, unknown>> }>
  input: unknown[]
  store?: boolean
  include?: string[]
}

const configOf = (protocol: "anthropic-messages" | "openai-responses"): ModelConfig => ({ protocol, provider: "test", model: "test-model", baseUrl: "https://test.invalid/v1", apiKey: "key", contextWindowTokens: 128_000 })
const thinking = { type: "thinking", thinking: "Compare the sources", signature: "signed opaque bytes" }
const redacted = { type: "redacted_thinking", data: "encrypted redaction" }
const reasoning = { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "Compare the sources" }], encrypted_content: "encrypted opaque bytes" }
const tool = { type: "tool_use", id: "a", name: "read", input: {} }
const call = { type: "function_call", id: "fc_a", call_id: "a", name: "read", arguments: "{}", status: "completed" }
const head: Event = { type: "MessageReceived", id: "m1", text: "Read both", at: 1 }
const identity = { actor: "test", instance: "main", thread: "root", turn: "m1" }
const sse = (events: readonly Record<string, unknown>[]) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
const anthropicEvents = [
  { type: "message_start", message: { id: "msg1", role: "assistant", model: "test-model", content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thinking.thinking } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: thinking.signature } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: redacted },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: tool },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
  { type: "message_stop" }
]
const openaiEvents = [
  { type: "response.created", response: { id: "resp1", model: "test-model", status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
  { type: "response.reasoning_summary_text.delta", item_id: "r1", output_index: 0, summary_index: 0, delta: "Compare the sources" },
  { type: "response.output_item.done", output_index: 0, item: reasoning },
  { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 1, delta: "{}" },
  { type: "response.function_call_arguments.done", item_id: "fc_a", output_index: 1, arguments: "{}" },
  { type: "response.output_item.done", output_index: 1, item: call },
  { type: "response.completed", response: { id: "resp1", model: "test-model", status: "completed", output: [reasoning, call], usage: { input_tokens: 5, output_tokens: 20 } } }
]

test.each(["anthropic-messages", "openai-responses"] as const)("%s preserves continuation through a serialized log and a fresh binding", async (protocol) => {
  const config = configOf(protocol)
  const bodies: CapturedBody[] = []
  const deltas: InferDelta[] = []
  const invoke = (trajectory: readonly Event[]) => Effect.runPromise(Effect.flatMap(Infer, (binding) => binding.react({ trajectory, identity, system: "", tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }] }, "m1/infer/0", undefined, (delta) => deltas.push(delta))).pipe(Effect.provide(infer({ ...config, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : await request.text()))
    return sse(protocol === "anthropic-messages" ? anthropicEvents : openaiEvents)
  } }, modelAdapters(anthropicAdapter, openAICompatibleAdapter)))))
  const action = await invoke([head])
  expect(action).toMatchObject({ kind: "calls", calls: [{ callId: "a", name: "read", arguments: {} }], reasoning: "Compare the sources" })
  const payload = protocol === "anthropic-messages" ? [thinking, redacted, tool] : [reasoning, call]
  expect(action.continuation?.payload).toEqual(payload)
  expect(deltas.filter((delta) => delta.kind === "reasoning").map((delta) => delta.text).join("")).toBe("Compare the sources")
  const events: Event[] = JSON.parse(JSON.stringify([
    head,
    { type: "ModelReturned", callId: "response-1", ordinal: 0, outcome: "returned", usage: {}, turn: "m1", at: 2, continuation: action.continuation, reasoning: action.reasoning },
    { type: "ToolCalled", callId: "a", name: "read", arguments: {}, responseId: "response-1", turn: "m1", at: 2 },
    { type: "ToolReturned", callId: "a", result: "contents", turn: "m1", at: 3 }
  ]))
  await invoke(events)
  const body = bodies[1]!
  if (protocol === "anthropic-messages") expect(body.messages.find((message) => message.role === "assistant")?.content).toEqual(payload)
  else {
    expect(body.input.slice(1, 3)).toEqual(payload)
    expect(body.store).toBe(false)
    expect(body.include).toContain("reasoning.encrypted_content")
  }
  const compacted = [...events, { type: "CompactionCompleted", keepFrom: `c:${JSON.stringify(["m1", "a"])}`, summary: "Earlier work", at: 4 }]
  expect(renderMessages(compacted).find((message) => message.role === "assistant")?.continuation?.payload).toEqual(payload)
})

test("continuation stays with each response and is omitted for incompatible requests", async () => {
  const config = configOf("anthropic-messages")
  const first = await responseStateOf([{ content: [thinking, tool] }], config)
  const second = await responseStateOf([{ content: [{ ...thinking, signature: "second" }, { ...tool, id: "b" }] }], config)
  const messages = [
    { role: "assistant" as const, content: null, toolCalls: [{ id: "a", name: "read", arguments: "{}" }], continuation: first.continuation! },
    { role: "assistant" as const, content: null, toolCalls: [{ id: "b", name: "read", arguments: "{}" }], continuation: second.continuation! }
  ]
  for (const changed of [config, { ...config, provider: "other" }, { ...config, model: "other" }, { ...config, baseUrl: "https://test.invalid/v1?tenant=other" }, configOf("openai-responses")]) {
    let sent: CapturedBody = { messages: [], input: [] }
    const fetch = withContinuation(async (_input, init) => { sent = JSON.parse(String(init?.body)); return new Response() }, changed, messages)
    const body = { messages: [{ role: "assistant", content: [tool] }, { role: "assistant", content: [{ ...tool, id: "b" }] }] }
    await fetch("https://test.invalid", { method: "POST", body: JSON.stringify(body) })
    if (changed === config) expect(sent.messages.map((message) => message.content[0]?.signature)).toEqual(["signed opaque bytes", "second"])
    else expect(sent as unknown).toEqual(body)
  }
  expect((await continuationScopeOf({ ...config, baseUrl: "https://secret:password@test.invalid/v1?key=secret" })).endpoint).not.toContain("secret")
})

test("encrypted-only responses retain state without fabricating display text", async () => {
  const item = { ...reasoning, summary: [] }
  const state = await responseStateOf([{ output: [item, call] }], configOf("openai-responses"))
  expect(state.reasoning).toBeUndefined()
  expect(state.continuation?.payload).toEqual([item, call])
})

test("Responses replays successive native outputs in conversation order", async () => {
  const config = configOf("openai-responses")
  const output1 = [reasoning, call]
  const output2 = [{ ...reasoning, id: "r2", encrypted_content: "second" }, { ...call, id: "fc_b", call_id: "b" }]
  const first = await responseStateOf([{ output: output1 }], config)
  const second = await responseStateOf([{ output: output2 }], config)
  const messages = [
    { role: "assistant" as const, content: null, toolCalls: [{ id: "a", name: "read", arguments: "{}" }], continuation: first.continuation! },
    { role: "tool" as const, content: "a result", toolCallId: "a" },
    { role: "assistant" as const, content: null, toolCalls: [{ id: "b", name: "read", arguments: "{}" }], continuation: second.continuation! }
  ]
  let sent: CapturedBody = { messages: [], input: [] }
  const fetch = withContinuation(async (_input, init) => { sent = JSON.parse(String(init?.body)); return new Response() }, config, messages)
  const result = { type: "function_call_output", call_id: "a", output: "a result" }
  await fetch(config.baseUrl, { method: "POST", body: JSON.stringify({ input: [call, result, { ...call, call_id: "b" }] }) })
  expect(sent.input).toEqual([...output1, result, ...output2])
})
