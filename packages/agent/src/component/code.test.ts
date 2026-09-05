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

    expect(transition).toMatchObject({ kind: "intent", key: `cs:${JSON.stringify(["m1", "exec-1"])}` })
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

describe("code identity across turns", () => {
  test("a reused execution id in another turn is not settled by the first turn's outcome", () => {
    // Provider execution ids are unique only within one model turn, so the component must read
    // the settle scoped by the turn and cancel the second turn's execution under its own key.
    const component = codeMode([])
    const events: ReadonlyArray<Event> = [
      { type: "CodeDispatched", execId: "exec-1", code: "work()", turn: "m1", at: 1 } as Event,
      { type: "CodeSettled", execId: "exec-1", error: "cancelled", turn: "m1", at: 2 } as Event,
      { type: "CodeDispatched", execId: "exec-1", code: "work()", turn: "m2", at: 3 } as Event
    ]
    const transition = cancelComponent(component, events, {
      request: "x2",
      invocation: { method: "message", id: "m2", epoch: 0 },
      cause: "requested"
    })[0]

    expect(transition).toMatchObject({ kind: "intent", key: `cs:${JSON.stringify(["m2", "exec-1"])}` })
  })
})
