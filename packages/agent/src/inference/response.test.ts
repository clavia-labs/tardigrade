import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelReturned } from "../log/events"
import { upcastResponse } from "../log/response-upcast"
import { usageIn } from "./usage"

test("native usage and metadata survive durable JSON without fabricated counts", () => {
  const event: typeof ModelReturned.Type = { type: "ModelReturned", callId: "a", ordinal: 0, turn: "t", at: 1, outcome: "returned", usage: { inputTokens: { total: 100 }, outputTokens: { total: 20, reasoning: 0 } }, response: { id: "r", modelId: "served", timestamp: "2026-09-12T00:00:00.000Z", metadata: { provider: { extra: [1, 2] } } }, finish: { reason: "stop", metadata: { provider: { usage: { future_metric: 7 } } } } }
  const decoded = Schema.decodeUnknownSync(ModelReturned)(JSON.parse(JSON.stringify(event)))
  expect(decoded).toEqual(event)
  expect(decoded.usage.outputTokens.text).toBeUndefined()
  expect(decoded.usage.inputTokens.cacheRead).toBeUndefined()
})

test("historical usage upcast preserves accounting without inventing a physical split", () => {
  const old = { type: "ModelReturned", callId: "a", ordinal: 0, turn: "t", at: 1, outcome: "returned", usage: { promptTokens: 100, reasoningTokens: 0, costUsd: 0.25, costSource: "provider" }, response: { id: "r", model: "old", finishReason: "stop", rawFinishReason: "end_turn" } }
  const before = JSON.stringify(old)
  const next = upcastResponse(old)
  expect(next.usage).toEqual({ inputTokens: { total: 100 }, outputTokens: { reasoning: 0 } })
  expect(next.legacyUsage).toEqual(old.usage)
  expect(next.legacyResponse).toEqual(old.response)
  expect(next.response).toEqual({ id: "r", modelId: "old" })
  expect(upcastResponse(next)).toEqual(next)
  expect(usageIn([next], "t")).toMatchObject({ promptTokens: 100, costUsd: 0.25 })
  expect(JSON.stringify(old)).toBe(before)
})
