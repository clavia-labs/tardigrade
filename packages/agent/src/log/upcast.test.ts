import { expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { upcast } from "./upcast"

test.each(["current", "legacy"])("upcast reads %s batches without inventing response events", (format) => {
  const calls: Event[] = [0, 1].map((index) => ({
    type: "ToolCalled", turn: "turn", callId: String(index), at: 1,
    ...(format === "current" ? { responseId: "response" } : { batchId: "response", batchIndex: index })
  }))
  const history: Event[] = format === "current"
    ? [{ type: "ModelReturned", turn: "turn", callId: "response", outcome: "returned", at: 1 }, ...calls]
    : calls
  const before = JSON.stringify(history)
  const view = upcast(history)
  expect(view.entries.filter((entry) => entry.advancesInference)).toHaveLength(1)
  expect(view.entries.filter((entry) => entry.event.type === "ToolCalled").map((entry) => entry.responseKey))
    .toEqual(['["turn",0,"response"]', '["turn",0,"response"]'])
  expect(view.entries.map((entry) => entry.event)).toEqual(history)
  view.entries.forEach((entry, index) => expect(entry.event).toBe(history[index]!))
  expect(JSON.stringify(history)).toBe(before)
  expect(upcast(view.entries.map((entry) => entry.event))).toEqual(view)
})

test("upcast preserves unknown starting allowances and recognizes recorded grants", () => {
  const head: Event = { type: "MessageReceived", id: "turn", at: 0 }
  expect(upcast([head]).budget).toEqual({ startingAllowance: undefined, needsInitialGrant: true })
  expect(upcast([{ ...head, budget: 3 }]).budget.startingAllowance).toBe(3)
  expect(upcast([head, { type: "ModelCalled", turn: "turn", at: 1 }]).budget)
    .toEqual({ startingAllowance: undefined, needsInitialGrant: false })
  expect(upcast([head, { type: "BudgetGranted", initial: true, amount: 3, turn: "turn", at: 1 }]).budget)
    .toEqual({ startingAllowance: 0, needsInitialGrant: false })
})

test("upcast normalizes failure strings without changing stored history", () => {
  const event: Event = { type: "TurnFailed", error: "provider refused", at: 1 }
  const view = upcast([event])
  expect(view.entries[0]?.event.error).toEqual({ message: "provider refused" })
  expect(event.error).toBe("provider refused")
  expect(upcast(view.entries.map(({ event }) => event))).toEqual(view)
})

test("upcast preserves structured model errors and reads historical strings", () => {
  for (const error of ["failed", { message: "failed", details: { code: "provider_error" } }]) {
    const stored = { type: "ModelReturned", callId: "a", outcome: "failed", error, at: 1 }
    const [entry] = upcast([stored]).entries
    expect(entry?.event.error).toEqual(typeof error === "string" ? { message: error } : error)
    expect(stored.error).toBe(error)
  }
})
