import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { agentMessageMethod, agentMethods } from "./message-method"

const head = agentMessageMethod.event({
  id: "m1",
  input: { text: "review it", input: { pull: 227 } },
  at: 1
})

describe("agentMessageMethod", () => {
  test("turns its typed input into the agent's durable inbound", () => {
    expect(head).toEqual({
      type: "MessageReceived",
      id: "m1",
      text: "review it",
      input: { pull: 227 },
      at: 1
    })
    expect(agentMethods).toEqual({ message: agentMessageMethod })
  })

  test("projects pending, blocked, completed, and failed states", () => {
    expect(agentMessageMethod.state([], "m1")).toBeUndefined()
    expect(agentMessageMethod.state([head], "m2")).toBeUndefined()
    expect(agentMessageMethod.state([head], "m1")).toEqual({ status: "pending" })
    expect(agentMessageMethod.state([
      head,
      { type: "BudgetRequested", turn: "m1", callId: "c1", reason: "one more check", amount: 1, at: 2 } as Event
    ], "m1")).toEqual({ status: "blocked", reason: "one more check" })
    expect(agentMessageMethod.state([
      head,
      { type: "TurnCompleted", turn: "m1", output: "done", at: 2 } as Event
    ], "m1")).toEqual({ status: "completed", output: "done" })
    expect(agentMessageMethod.state([
      head,
      { type: "TurnFailed", turn: "m1", error: "provider refused", at: 2 } as Event
    ], "m1")).toEqual({ status: "failed", error: "provider refused" })
  })
})
