import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { toolsComponentFrom, toolsReactorFrom } from "./tools"

const invocation = { method: "message", id: "m1", epoch: 0 } as const

describe("tool cancellation", () => {
  test("settles every open call through the tool component contract", () => {
    const component = toolsComponentFrom(undefined, () => [], () => [])
    const transitions = component.cancel?.([
      { type: "ToolCalled", callId: "tool-1", name: "write", arguments: {}, turn: "m1", at: 1 },
      { type: "ToolCalled", callId: "tool-2", name: "read", arguments: {}, turn: "m1", at: 2 }
    ], {
      request: "x1",
      invocation,
      cause: "requested",
      reason: "operator stopped it"
    }) ?? []

    expect(transitions.map((transition) => transition.key)).toEqual(["tr:tool-1", "tr:tool-2"])
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
