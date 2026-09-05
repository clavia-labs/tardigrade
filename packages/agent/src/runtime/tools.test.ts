import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { cancelComponent } from "@clavia/tardigrade-core/component"
import { toolCallIdentity } from "../log/events"
import { incrementalToolsComponentFrom, toolsReactorFrom } from "./tools"

const invocation = (id: string) => ({ method: "message" as const, id, epoch: 0 })

const called = (callId: string, turn: string, at: number): Event =>
  ({ type: "ToolCalled", callId, name: "write", arguments: {}, turn, at })

const returned = (callId: string, turn: string, at: number): Event =>
  ({ type: "ToolReturned", callId, result: "done", turn, at })

describe("tool call identity across turns", () => {
  test("reused call ids across turns key distinct tool returns", () => {
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "work", at: 1 },
      called("c1", "m1", 2),
      returned("c1", "m1", 3),
      { type: "MessageReceived", id: "m2", text: "again", at: 4 },
      called("c1", "m2", 5)
    ]
    const reactor = toolsReactorFrom(() => undefined, () => [])
    const transitions = reactor(log)
    expect(transitions.map((transition) => transition.key))
      .toEqual([`tr:${toolCallIdentity("m2", "c1")}`])
  })

  test("an unstamped tool return keeps its bare call id", () => {
    const log: ReadonlyArray<Event> = [
      { type: "ToolCalled", callId: "c1", name: "write", arguments: {}, at: 1 },
      { type: "ToolReturned", callId: "c1", result: "done", at: 2 }
    ]
    const reactor = toolsReactorFrom(() => undefined, () => [])
    expect(reactor(log)).toEqual([])
  })

  test("cancelling one turn settles only its reused call id", () => {
    const child = {
      initial: () => undefined,
      step: (state: unknown) => state,
      output: () => ({ view: undefined, transitions: [] })
    }
    const component = incrementalToolsComponentFrom(undefined, child, () => [])
    const projection = component.machine
    let state = projection.initial()
    for (const event of [called("c1", "m1", 1), called("c1", "m2", 2)]) {
      state = projection.step(state, event)
    }
    const settle = projection.cancel?.(state, {
      request: "x1",
      invocation: invocation("m1"),
      cause: "requested"
    })
    expect(settle?.map((transition) => transition.key)).toEqual([`tr:${toolCallIdentity("m1", "c1")}`])
    state = projection.step(state, returned("c1", "m1", 3))
    const remaining = projection.cancel?.(state, {
      request: "x2",
      invocation: invocation("m2"),
      cause: "requested"
    })
    expect(remaining?.map((transition) => transition.key)).toEqual([`tr:${toolCallIdentity("m2", "c1")}`])
  })

  test("a settled reused call id absorbs only its own redelivery", () => {
    // The complete-history component agrees with the incremental projection: a cancellation
    // recorded for one turn cannot settle another turn's call that reuses the id.
    const component = incrementalToolsComponentFrom(undefined, {
      initial: () => undefined,
      step: (state: unknown) => state,
      output: () => ({ view: undefined, transitions: [] })
    }, () => [])
    const log: ReadonlyArray<Event> = [
      called("c1", "m1", 1),
      { type: "ToolReturned", callId: "c1", result: { error: "cancelled" }, turn: "m1", at: 2 },
      called("c1", "m2", 3)
    ]
    const transitions = cancelComponent(component, log, {
      request: "x2",
      invocation: invocation("m2"),
      cause: "requested"
    })
    expect(transitions.map((transition) => transition.key)).toEqual([`tr:${toolCallIdentity("m2", "c1")}`])
  })
})
