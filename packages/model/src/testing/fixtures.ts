const reasoningFixture = () => [
  { type: "reasoning", id: "rs_a", encrypted_content: "opaque-a", summary: [{ type: "summary_text", text: "Check" }] },
  { type: "reasoning", id: "rs_b", encrypted_content: "opaque-b", summary: [] }
]
const thinkingFixture = () => ({ type: "thinking", thinking: "Check", signature: "signed" })
const redactedFixture = () => ({ type: "redacted_thinking", data: "opaque" })
const callsFixture = () => ["a", "b", "c"].map((id) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: "read", arguments: JSON.stringify({ path: id }) }))

export const reasoning = reasoningFixture()
export const thinking = thinkingFixture()
export const redacted = redactedFixture()
export const calls = callsFixture()

export const providerEvents = (provider: "openai" | "anthropic", malformed: boolean) => {
  const responseReasoning = reasoningFixture()
  const responseRedacted = redactedFixture()
  const fixtureCalls = callsFixture()
  const responseCalls = malformed ? fixtureCalls.map((call) => call.call_id === "b" ? ({ ...call, arguments: JSON.stringify({ path: 123 }) }) : call) : fixtureCalls
  const events = provider === "openai" ? [
      ...[...responseReasoning, ...responseCalls].flatMap((item, output_index) => [
        { type: "response.output_item.added", output_index, item },
        ...(item.type === "reasoning" && "summary" in item ? item.summary.map((part) => ({ type: "response.reasoning_summary_text.delta", item_id: item.id, output_index, summary_index: 0, delta: part.text })) : []),
        { type: "response.output_item.done", output_index, item }
      ]),
      { type: "response.completed", response: { id: "response", created_at: 1, model: "gpt-5", status: "completed", output: [...responseReasoning, ...responseCalls], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } }
    ] : [
      { type: "message_start", message: { id: "message", type: "message", role: "assistant", content: [], container: null, stop_reason: null, stop_sequence: null, model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 0, inference_geo: null, cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: "standard" } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: responseRedacted },
      { type: "content_block_stop", index: 1 },
      ...["a", "b", "c"].flatMap((id, i) => [
        { type: "content_block_start", index: i + 2, content_block: { type: "tool_use", id, name: "read", input: {} } },
        { type: "content_block_delta", index: i + 2, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: malformed && id === "b" ? 123 : id }) } },
        { type: "content_block_stop", index: i + 2 }
      ]),
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5, input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null } },
      { type: "message_stop" }
    ]
  return events.map((event) => structuredClone(event))
}
