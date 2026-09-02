import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { cancelComponent } from "@clavia/tardigrade-core/component"
import { codeMode } from "./code"

describe("code cancellation", () => {
  test("the component settles one open execution before its invocation terminal", () => {
    const component = codeMode([])
    const transition = cancelComponent(component, [
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

  test("the incremental code projection derives the same cancellation obligation", () => {
    const component = codeMode([])
    const projection = component.machine
    const events: ReadonlyArray<Event> = [
      { type: "CodeDispatched", execId: "exec-1", code: "work()", turn: "m1", at: 1 } as Event
    ]
    const cancellation = {
      request: "x1",
      invocation: { method: "message", id: "m1", epoch: 0 },
      cause: "requested" as const
    }
    const state = events.reduce(projection.step, projection.initial())

    expect(projection.cancel?.(state, cancellation).map((transition) => transition.key))
      .toEqual(cancelComponent(component, events, cancellation).map((transition) => transition.key))
  })
})
