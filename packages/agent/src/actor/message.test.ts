import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { AgentEvent } from "../log/events"
import { requestBudgetMethod } from "./budget"
import { agentMessageMethod } from "./message"
import { agentMethods } from "./methods"

const head = agentMessageMethod.event({
  invocation: { method: "message", id: "m1", epoch: 0 },
  input: {
    text: "review it",
    input: { pull: 227 },
    model: { provider: "openai", model_id: "gpt-5.2" }
  },
  at: 1
})

describe("agentMessageMethod", () => {
  test("turns its typed input into the agent's durable inbound", () => {
    expect(head).toEqual({
      type: "MessageReceived",
      id: "m1",
      text: "review it",
      input: { pull: 227 },
      model: { provider: "openai", model_id: "gpt-5.2" },
      at: 1
    })
    expect(agentMessageMethod.eventOf({
      invocation: { method: "message", id: "m2", epoch: 0 },
      input: {
        text: "switch providers",
        model: { provider: "openai", model_id: "gpt-5.6" }
      },
      at: 2
    })).toEqual({
      type: "MessageReceived",
      id: "m2",
      text: "switch providers",
      model: { provider: "openai", model_id: "gpt-5.6" },
      at: 2
    })
    expect(agentMethods).toEqual({ message: agentMessageMethod, requestBudget: requestBudgetMethod })
  })

  test("stays pending through negotiation and projects terminal states", () => {
    const invocation = (id: string) => ({ method: "message", id, epoch: 0 })
    expect(agentMessageMethod.state([], invocation("m1"))).toBeUndefined()
    expect(agentMessageMethod.state([head], invocation("m2"))).toBeUndefined()
    expect(agentMessageMethod.state([head], invocation("m1"))).toEqual({ status: "pending" })
    expect(agentMessageMethod.state([
      head,
      { type: "BudgetRequested", turn: "m1", callId: "c1", reason: "one more check", amount: 1, at: 2 } as Event
    ], invocation("m1"))).toEqual({ status: "pending" })
    expect(agentMessageMethod.state([
      head,
      { type: "TurnCompleted", turn: "m1", output: "done", at: 2 } as Event
    ], invocation("m1"))).toEqual({ status: "completed", output: "done" })
    expect(agentMessageMethod.state([
      head,
      { type: "TurnFailed", turn: "m1", error: "provider refused", at: 2 } as Event
    ], invocation("m1"))).toEqual({ status: "failed", error: "provider refused" })
    expect(agentMessageMethod.state([
      head,
      { type: "TurnCancelled", request: "x1", turn: "m1", cause: "requested", reason: "operator stopped it", at: 2 } as Event
    ], invocation("m1"))).toEqual({ status: "cancelled", cause: "requested", reason: "operator stopped it" })
  })

  test("constructs and projects cancellation", () => {
    const invocation = { method: "message", id: "m1", epoch: 0 }
    const cancellation = { request: "x1", invocation, cause: "requested" as const, reason: "operator stopped it" }
    const request = { type: "CancellationRequested", ...cancellation, at: 2 } as Event

    expect(agentMessageMethod.cancellation.event(cancellation, 3)).toEqual({
      type: "TurnCancelled",
      request: "x1",
      cause: "requested",
      reason: "operator stopped it",
      turn: "m1",
      at: 3
    })
    expect(agentMessageMethod.cancellation.state([], invocation)).toBeUndefined()
    expect(agentMessageMethod.cancellation.state([head, request], invocation)).toBe("running")
    expect(agentMessageMethod.cancellation.state([
      head,
      request,
      { type: "TurnCancelled", request: "x1", turn: "m1", cause: "requested", reason: "operator stopped it", at: 3 } as Event
    ], invocation)).toBe("cancelled")
    expect(agentMessageMethod.cancellation.state([
      head,
      request,
      { type: "TurnCompleted", turn: "m1", output: "done", at: 3 } as Event
    ], invocation)).toBe("terminal")
  })

  test("preserves cancellation invocation identity", () => {
    expect(Schema.decodeSync(AgentEvent)({
      type: "TurnCancelled",
      request: "x1",
      turn: "m1",
      cause: "requested",
      epoch: 1,
      at: 3
    })).toEqual({ type: "TurnCancelled", request: "x1", turn: "m1", cause: "requested", epoch: 1, at: 3 })
  })
})
