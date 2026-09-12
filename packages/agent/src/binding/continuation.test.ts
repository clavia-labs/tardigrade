import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { ProviderContinuation, continuationOf } from "../inference/continuation"
import { upcastResponse } from "../log/response-upcast"
import { replayOf } from "./continuation"

const identity = { provider: "fixture", protocol: "responses", model: "reasoner" }
const payload = Schema.encodeSync(Prompt.Prompt)(Prompt.make([
  Prompt.assistantMessage({ content: [
    Prompt.makePart("reasoning", { text: "Check the result", options: { fixture: { signature: "opaque-token" } } }),
    Prompt.makePart("tool-call", { id: "a", name: "read", params: { path: "file" }, providerExecuted: false })
  ] })
]))
const continuation = { format: "effect-prompt", ...identity, endpoint: "https://fixture.test", payload } as const

test("a JSON continuation retains native reasoning and tool evidence for compatible replay", () => {
  const stored = JSON.parse(JSON.stringify(continuation))
  const decoded = Schema.decodeUnknownSync(ProviderContinuation)(stored)
  expect(Schema.encodeSync(Prompt.Prompt)(Prompt.make(replayOf(decoded, identity).messages!))).toEqual(payload)
  expect(replayOf(decoded, { ...identity, model: "other" })).toEqual({ reasoning: ["Check the result"] })
  expect(replayOf(decoded, { ...identity, provider: "other" })).toEqual({ reasoning: ["Check the result"] })
  expect(replayOf(decoded, { ...identity, protocol: "other" })).toEqual({ reasoning: ["Check the result"] })
})

test("historical prompt arrays upcast without replacing their native evidence", () => {
  const legacy = { ...continuation, payload: payload.content }
  const event = { type: "ModelReturned", callId: "a", ordinal: 0, turn: "t", outcome: "returned", continuation: legacy, at: 1 }
  expect(upcastResponse(event).continuation).toEqual(continuation)
  expect(legacy.payload).toEqual(payload.content)
})

test("unknown formats and malformed prompts cannot become native continuations", () => {
  expect(continuationOf({ ...continuation, format: "unknown" })).toBeUndefined()
  expect(continuationOf({ ...continuation, payload: { content: [{ role: "invalid", content: [] }] } })).toBeUndefined()
})
