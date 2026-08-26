import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { requestBudgetMethod } from "./budget"

const request = requestBudgetMethod.event({
  id: "budget-1",
  input: {
    request: "tool-1",
    turn: "run-1",
    reason: "one source remains",
    amount: 2
  },
  at: 1
})

describe("requestBudgetMethod", () => {
  test("projects one grant or denial terminal for its call", () => {
    expect(requestBudgetMethod.state([], "budget-1")).toBeUndefined()
    expect(requestBudgetMethod.state([request], "budget-1")).toEqual({ status: "pending" })
    expect(requestBudgetMethod.state([
      request,
      { type: "BudgetRequestDecided", callId: "budget-1", grant: 2, at: 2 } as Event
    ], "budget-1")).toEqual({ status: "completed", output: { granted: 2 } })
    expect(requestBudgetMethod.state([
      request,
      { type: "BudgetRequestDecided", callId: "budget-1", grant: 0, reason: "optional", at: 2 } as Event
    ], "budget-1")).toEqual({ status: "completed", output: { denied: true, reason: "optional" } })
    expect(requestBudgetMethod.state([
      request,
      { type: "BudgetRequestFailed", callId: "budget-1", error: "authority unavailable", at: 2 } as Event
    ], "budget-1")).toEqual({ status: "failed", error: "authority unavailable" })
  })
})
