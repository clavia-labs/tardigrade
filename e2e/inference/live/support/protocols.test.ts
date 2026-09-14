import { expect, test } from "bun:test"
import { chatCompletions } from "./protocols/chat-completions"
import { messages } from "./protocols/messages"
import { responses } from "./protocols/responses"

test("Responses retains encrypted reasoning evidence", () => {
  const stream = `data: ${JSON.stringify({ type: "response.completed", response: { usage: { output_tokens_details: { reasoning_tokens: 7 } }, output: [{ id: "r", type: "reasoning", encrypted_content: "sealed" }] } })}\n\n`
  expect(responses.responseEvidence(stream)).toEqual({ opaqueParts: 1, reasoningTokens: 7 })
  expect(responses.opaqueEvidence(stream)).toEqual(["sealed"])
})

test("Chat Completions retains reasoning details", () => {
  const stream = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "sealed" }] } }] })}\n\n`
  expect(chatCompletions.responseEvidence(stream).opaqueParts).toBe(1)
  expect(chatCompletions.opaqueEvidence(stream)).toEqual(["sealed"])
  expect(chatCompletions.opaqueEvidence('data: {"choices":[{"delta":{"reasoning_details":[],"reasoning_content":"Readable"}}]}\n\n')).toEqual([])
  expect(chatCompletions.followUpEvidence(JSON.stringify({ messages: [{ reasoning_details: [{ type: "reasoning.encrypted", data: "sealed" }] }, { role: "tool", content: "nonce" }] }), "nonce")).toEqual({ opaqueParts: 1, hasToolResult: true })
})

test("Messages retains thinking signatures", () => {
  const stream = `data: ${JSON.stringify({ delta: { signature: "signed" } })}\n\n`
  expect(messages.responseEvidence(stream).opaqueParts).toBe(1)
  expect(messages.opaqueEvidence(stream)).toEqual(["signed"])
})


test("Responses replay uses final reasoning items instead of interim encrypted values", () => {
  const frames = [
    { type: "response.output_item.added", item: { id: "r", encrypted_content: "interim" } },
    { type: "response.output_item.done", item: { id: "r", encrypted_content: "final" } },
    { type: "response.completed", response: { output: [{ id: "r", encrypted_content: "completion-copy" }] } }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  expect(responses.opaqueEvidence(frames)).toEqual(["final"])
})
