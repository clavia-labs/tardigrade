import { expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { firstResponseCallIndex, returnedAttemptCount, toolResponseKey } from "./response"

test.each(["current", "legacy", "singleton"])("response readers preserve %s history", (format) => {
  const calls: Event[] = [0, 1].map((index) => ({
    type: "ToolCalled", turn: "turn", callId: String(index), at: 1,
    ...(format === "current" ? { responseId: "response" } : format === "legacy" ? { batchId: "response", batchIndex: index } : {})
  }))
  const history: Event[] = format === "current"
    ? [{ type: "ModelReturned", callId: "response", outcome: "returned", at: 1 }, ...calls]
    : calls
  const before = JSON.stringify(history)
  expect(firstResponseCallIndex(history, calls[1]!)).toBe(format === "current" ? 1 : format === "legacy" ? 0 : 1)
  expect(returnedAttemptCount(history)).toBe(format === "singleton" ? 2 : 1)
  expect(toolResponseKey(calls[0]!)).toBe(toolResponseKey(calls[1]!))
  expect(JSON.stringify(history)).toBe(before)
})

test("response counts distinguish retries, rejections and old consequences", () => {
  const history: Event[] = [
    { type: "ModelCalled", callId: "retry", at: 0 },
    { type: "ModelReturned", callId: "retry", outcome: "failed", at: 1 },
    { type: "ModelReturned", callId: "retry", outcome: "returned", at: 2 },
    { type: "OutputRejected", attempt: "retry", at: 2 },
    { type: "OutputRejected", attempt: "old", at: 3 }
  ]
  expect(returnedAttemptCount(history)).toBe(2)
  expect(toolResponseKey({ type: "ToolCalled", turn: "a", responseId: "same", at: 1 }))
    .not.toBe(toolResponseKey({ type: "ToolCalled", turn: "b", responseId: "same", at: 1 }))
})
