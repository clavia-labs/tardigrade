import { expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { factsOf } from "./projections"

test("distinct transition owners keep executions separate when payload IDs repeat within a turn", () => {
  const events: Event[] = [
    {
      type: "CodeDispatched", execId: "same", code: "1", turn: "turn", at: 1,
      transitionRef: { seq: 12, component: "code", tag: "dispatch" }
    },
    {
      type: "CodeDispatched", execId: "same", code: "2", turn: "turn", at: 2,
      transitionRef: { seq: 19, component: "code", tag: "dispatch" }
    }
  ]

  expect(factsOf(events)).toHaveLength(2)
  events.push({ type: "CodeSettled", execId: "same", turn: "turn", at: 3,
    executionRef: { seq: 12, component: "code", tag: "dispatch" } })
  expect(factsOf(events).map((execution) => execution.settled)).toEqual([true, false])
})
