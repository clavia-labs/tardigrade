import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { ProviderContinuation } from "../continuation"
import { replayOf } from "./continuation"
import { historyOf } from "./prompt"
import type { AgentMessage } from "../../projection/messages"

const identity = { provider: "fixture", protocol: "responses", model: "reasoner" }
const payload = Schema.encodeSync(Prompt.Prompt)(Prompt.make([
  Prompt.assistantMessage({ content: [
    Prompt.makePart("reasoning", { text: "Check the result", options: { fixture: { signature: "opaque-token" } } }),
    Prompt.makePart("tool-call", { id: "a", name: "read", params: { path: "file" }, providerExecuted: false })
  ] })
]))
const continuation = { ...identity, endpoint: "https://fixture.test", payload } as const

test("a JSON continuation retains native reasoning and tool evidence for compatible replay", () => {
  const stored = JSON.parse(JSON.stringify(continuation))
  const decoded = Schema.decodeUnknownSync(ProviderContinuation)(stored)
  expect(Schema.encodeSync(Prompt.Prompt)(Prompt.make(replayOf(decoded, identity)!))).toEqual(payload)

})

test("continuation payloads must satisfy the encoded Prompt schema", () => {
  for (const invalid of [payload.content, { content: [{ role: "invalid", content: [] }] }]) {
    expect(() => Schema.decodeUnknownSync(ProviderContinuation)({ ...continuation, payload: invalid })).toThrow()
  }
  expect(replayOf(undefined, identity)).toBeUndefined()
})

test("identity changes retain answers and tool exchanges without carrying reasoning", () => {
  const messages: ReadonlyArray<AgentMessage> = [
    { role: "assistant", content: "Reading the file", continuation,
      toolCalls: [{ id: "a", name: "read", arguments: '{"path":"file"}' }] },
    { role: "tool", content: "File contents", toolCallId: "a" }
  ]
  const stored = JSON.stringify(messages)
  const expected = Prompt.make([
    Prompt.assistantMessage({ content: [
      Prompt.makePart("text", { text: "Reading the file" }),
      Prompt.makePart("tool-call", { id: "a", name: "read", params: { path: "file" }, providerExecuted: false })
    ] }),
    Prompt.toolMessage({ content: [Prompt.makePart("tool-result", {
      id: "a", name: "read", result: "File contents", isFailure: false, providerExecuted: false
    })] })
  ])
  for (const field of ["provider", "protocol", "model"] as const) {
    const target = { ...identity, [field]: "other" }
    expect(replayOf(continuation, target)).toBeUndefined()
    expect(Prompt.make(historyOf(messages, target))).toEqual(expected)
    expect(JSON.stringify(messages)).toBe(stored)
  }
})
