import { expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { responseKeyOf } from "./upcast"
import { hasUnansweredToolCall, responsesOf } from "./response"

test.each(["current", "legacy", "singleton"])("response readers preserve %s history", (format) => {
  const calls: Event[] = [0, 1].map((index) => ({
    type: "ToolCalled", turn: "turn", callId: String(index), at: 1,
    ...(format === "current" ? { responseId: "response" } : format === "legacy" ? { batchId: "response", batchIndex: index } : {})
  }))
  const history: Event[] = format === "current"
    ? [{ type: "ModelReturned", callId: "response", outcome: "returned", at: 1 }, ...calls]
    : calls
  const before = JSON.stringify(history)
  const responses = responsesOf(history)
  expect(responses.firstCalls.get(calls[1]!)).toBe(calls[format === "singleton" ? 1 : 0]!)
  expect(responsesOf(history).returnedAttempts).toBe(format === "singleton" ? 2 : 1)
  expect(responses.keys.get(calls[0]!)).toBe(responses.keys.get(calls[1]!))
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
  expect(responsesOf(history).returnedAttempts).toBe(2)
  const calls: Event[] = ["a", "b"].map((turn) => ({ type: "ToolCalled", turn, responseId: "same", at: 1 }))
  const responses = responsesOf(calls)
  expect(responses.keys.get(calls[0]!)).not.toBe(responses.keys.get(calls[1]!))
  expect(responses.firstCalls.get(calls[1]!)).toBe(calls[1]!)
})

test("response identity includes turn and epoch", () => {
  const event = { type: "ModelReturned", turn: "turn", epoch: 2, callId: "response", at: 0 } as Event
  expect(responseKeyOf(event, "response")).toBe('["turn",2,"response"]')
  expect(responseKeyOf({ ...event, turn: "other" }, "response")).not.toBe(responseKeyOf(event, "response"))
  expect(responseKeyOf({ ...event, epoch: 3 }, "response")).not.toBe(responseKeyOf(event, "response"))
})

test("unanswered tool calls close when their result arrives", () => {
  const called = { type: "ToolCalled", callId: "call", at: 0 } as Event
  expect(hasUnansweredToolCall([called])).toBe(true)
  expect(hasUnansweredToolCall([called, { type: "ToolReturned", callId: "call", result: null, at: 1 } as Event])).toBe(false)
})
