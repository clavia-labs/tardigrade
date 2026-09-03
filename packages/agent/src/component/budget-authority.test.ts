import { describe, expect, test } from "bun:test"
import { deriveComponent } from "@clavia/tardigrade-core/component"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { budgetAuthority, budgetAuthorityKeys } from "./budget-authority"

const received: Event = {
  type: "BudgetRequestReceived",
  id: "budget-1",
  request: "tool-1",
  turn: "run-1",
  reason: "one source remains",
  amount: 2,
  at: 1
}

const eventsOf = (component: ReturnType<typeof budgetAuthority>, log: ReadonlyArray<Event>): ReadonlyArray<Event> => {
  const transition = deriveComponent(component, log).transitions[0]
  if (transition === undefined) return []
  expect(transition.kind).toBe("intent")
  return transition.kind === "intent" ? transition.events(transition.input, 2) : []
}

describe("budgetAuthority", () => {
  test("records a local grant as one terminal authority decision", () => {
    const component = budgetAuthority({ decide: (request) => request.grant(3) })
    const events = eventsOf(component, [received])

    expect(events).toEqual([{ type: "BudgetRequestDecided", callId: "budget-1", grant: 3, at: 2 }])
    expect(budgetAuthorityKeys.keyOf(events[0]!)).toBe("ba:budget-1")
    expect(deriveComponent(component, [received, ...events]).transitions).toEqual([])
  })

  test("turns a policy exception into a durable method failure", () => {
    const component = budgetAuthority({
      decide: () => {
        throw new Error("policy unavailable")
      }
    })
    const events = eventsOf(component, [received])

    expect(events).toEqual([{
      type: "BudgetRequestFailed",
      callId: "budget-1",
      error: "policy unavailable",
      at: 2
    }])
    expect(budgetAuthorityKeys.keyOf(events[0]!)).toBe("ba:budget-1")
    expect(deriveComponent(component, [received, ...events]).transitions).toEqual([])
  })

  test("rejects an invalid grant as a durable method failure", () => {
    const component = budgetAuthority({ decide: (request) => request.grant(0) })

    expect(eventsOf(component, [received])).toEqual([{
      type: "BudgetRequestFailed",
      callId: "budget-1",
      error: "budget grant must be a positive integer, got 0",
      at: 2
    }])
  })
})
