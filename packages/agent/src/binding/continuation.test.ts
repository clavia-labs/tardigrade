import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { ProviderContinuation } from "../inference/continuation"
import { replayOf } from "./continuation"

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
  expect(Schema.encodeSync(Prompt.Prompt)(Prompt.make(replayOf(decoded, identity).messages!))).toEqual(payload)
  expect(replayOf(decoded, { ...identity, model: "other" })).toEqual({ reasoning: ["Check the result"] })
  expect(replayOf(decoded, { ...identity, provider: "other" })).toEqual({ reasoning: ["Check the result"] })
  expect(replayOf(decoded, { ...identity, protocol: "other" })).toEqual({ reasoning: ["Check the result"] })
})

test("continuation payloads must satisfy the encoded Prompt schema", () => {
  for (const invalid of [payload.content, { content: [{ role: "invalid", content: [] }] }]) {
    expect(() => Schema.decodeUnknownSync(ProviderContinuation)({ ...continuation, payload: invalid })).toThrow()
  }
  expect(replayOf(undefined, identity)).toEqual({ reasoning: [] })
})
