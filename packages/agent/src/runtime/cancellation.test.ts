import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { cancelComponent } from "@clavia/tardigrade-core/component"
import { incrementalToolsComponentFrom, toolsComponentFrom, toolsReactorFrom } from "./tools"

const invocation = { method: "message", id: "m1", epoch: 0 } as const

describe("tool cancellation", () => {
  test("settles every open call through the tool component contract", () => {
    const component = toolsComponentFrom(undefined, () => [], () => [])
    const transitions = cancelComponent(component, [
      { type: "ToolCalled", callId: "tool-1", name: "write", arguments: {}, turn: "m1", at: 1 },
      { type: "ToolCalled", callId: "tool-2", name: "read", arguments: {}, turn: "m1", at: 2 }
    ], {
      request: "x1",
      invocation,
      cause: "requested",
      reason: "operator stopped it"
    })

    expect(transitions.map((transition) => transition.key))
      .toEqual(["tr:" + JSON.stringify(["m1", "tool-1"]), "tr:" + JSON.stringify(["m1", "tool-2"])])
  })

  test("the incremental tool projection derives the same cancellation obligations", () => {
    const child = {
      initial: () => undefined,
      step: (state: unknown) => state,
      output: () => ({ view: undefined, transitions: [] })
    }
    const component = incrementalToolsComponentFrom(undefined, child, () => [])
    const projection = component.machine
    const events: ReadonlyArray<Event> = [
      { type: "ToolCalled", callId: "tool-1", name: "write", arguments: {}, turn: "m1", at: 1 },
      { type: "ToolCalled", callId: "tool-2", name: "read", arguments: {}, turn: "m1", at: 2 }
    ]
    const state = events.reduce(projection.step, projection.initial())
    const cancellation = { request: "x1", invocation, cause: "requested" as const }

    expect(projection.cancel?.(state, cancellation).map((transition) => transition.key))
      .toEqual(cancelComponent(component, events, cancellation).map((transition) => transition.key))
  })

  test("the incremental tool projection reads the child view only for offer events", () => {
    let derivations = 0
    const child = {
      initial: () => 0,
      step: (state: unknown) => Number(state) + 1,
      output: () => {
        derivations += 1
        return { view: undefined, transitions: [] }
      }
    }
    const projection = incrementalToolsComponentFrom(undefined, child, () => []).machine
    let state = projection.initial()
    state = projection.step(state, { type: "MessageReceived", id: "m1", text: "work", at: 1 } as Event)
    state = projection.step(state, { type: "TextReturned", text: "working", turn: "m1", at: 2 } as Event)
    state = projection.step(state, { type: "TurnCompleted", turn: "m1", output: "done", at: 3 } as Event)
    expect(derivations).toBe(0)
    state = projection.step(state, { type: "ModelCalled", callId: "model-1", turn: "m2", at: 4 } as Event)
    expect(derivations).toBe(1)
  })

  test("a tool call appended after cancellation is inert", () => {
    let served = false
    const reactor = toolsReactorFrom(() => {
      served = true
      return []
    }, () => [])
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "work", at: 1 },
      { type: "TurnCancelled", request: "x1", turn: "m1", cause: "requested", at: 2 },
      { type: "ToolCalled", callId: "late", name: "write", arguments: {}, turn: "m1", at: 3 }
    ]
    expect(reactor(log)).toEqual([])
    expect(served).toBe(false)
  })
})
