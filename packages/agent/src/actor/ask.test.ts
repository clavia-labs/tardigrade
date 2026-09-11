import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { AgentEvent } from "../log/events"
import { requestAskMethod } from "./ask"

const request = requestAskMethod.event({
  invocation: { method: "requestAsk", id: "ask-1", epoch: 0 },
  input: {
    request: "tool-1",
    turn: "run-1",
    prompt: "Approve the release?",
    schema: {
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
      additionalProperties: false
    }
  },
  at: 1
})

describe("requestAskMethod", () => {
  test("projects one answer or denial terminal for its call", () => {
    const invocation = { method: "requestAsk", id: "ask-1", epoch: 0 }
    expect(requestAskMethod.state([], invocation)).toBeUndefined()
    expect(requestAskMethod.state([request], invocation)).toEqual({ status: "pending" })
    expect(requestAskMethod.state([
      request,
      { type: "AskRequestDecided", callId: "ask-1", denied: false, answer: { approved: true }, at: 2 } as Event
    ], invocation)).toEqual({ status: "completed", output: { answered: { approved: true } } })
    expect(requestAskMethod.state([
      request,
      { type: "AskRequestDecided", callId: "ask-1", denied: true, reason: "needs review", at: 2 } as Event
    ], invocation)).toEqual({ status: "completed", output: { denied: true, reason: "needs review" } })
    expect(requestAskMethod.state([
      request,
      { type: "AskRequestFailed", callId: "ask-1", error: "authority unavailable", at: 2 } as Event
    ], invocation)).toEqual({ status: "failed", error: "authority unavailable" })
  })

  test("AskRequested is an AgentEvent", () => {
    expect(Schema.decodeSync(AgentEvent)({
      type: "AskRequested",
      callId: "a1",
      prompt: "Approve the release?",
      schema: {
        type: "object",
        properties: { approved: { type: "boolean" } },
        required: ["approved"],
        additionalProperties: false
      },
      turn: "m1",
      at: 1
    })).toMatchObject({ type: "AskRequested", callId: "a1" })
  })
})
