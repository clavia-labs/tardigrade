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
