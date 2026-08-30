import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { codeMode } from "./code"

describe("code cancellation", () => {
  test("the component settles one open execution before its invocation terminal", () => {
    const component = codeMode([])
    const transition = component.cancel?.([
      { type: "CodeDispatched", execId: "exec-1", code: "work()", turn: "m1", at: 1 }
    ] as ReadonlyArray<Event>, {
      request: "x1",
      invocation: { method: "message", id: "m1", epoch: 0 },
      cause: "requested",
      reason: "operator stopped it"
    })[0]

    expect(transition).toMatchObject({ kind: "intent", key: "cs:exec-1" })
    if (transition?.kind !== "intent") return
    expect(transition.events(transition.input, 2)).toEqual([{
      type: "CodeSettled",
      execId: "exec-1",
      error: "cancelled: operator stopped it",
      turn: "m1",
      at: 2
    }])
  })
})
