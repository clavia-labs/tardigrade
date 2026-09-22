import { component as defineComponent } from "@clavia/tardigrade-core/component"
import { testMachineOf as machineOf } from "@clavia/tardigrade-agent/fixtures/component"
import { replayState } from "@clavia/tardigrade-core/projection"
import { eventAt } from "@clavia/tardigrade-core/event"
import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"

import { routeTools, toolsComponentFrom, toolsReactorFrom } from "../component/tool/machine"

const invocation = { method: "message", id: "m1", epoch: 0 } as const

describe("tool cancellation", () => {
  test("settles every open call through the tool component contract", () => {
    const component = toolsComponentFrom(undefined, () => [], () => [])
    const transitions = (machineOf(component).output(replayState(machineOf(component), [
      { type: "ToolCalled", callId: "tool-1", name: "write", arguments: {}, turn: "m1", at: 1 },
      { type: "ToolCalled", callId: "tool-2", name: "read", arguments: {}, turn: "m1", at: 2 }
    ])).interactions?.cancel?.({
      request: "x1",
      invocation,
      cause: "requested",
      reason: "operator stopped it"
    }) ?? [])

    expect(transitions.map((transition) => transition.key)).toEqual([JSON.stringify([1, "agent.tools", "answer"]), JSON.stringify([2, "agent.tools", "answer"])])
  })

  test("the incremental tool projection derives the same cancellation obligations", () => {
    const child = defineComponent({
      name: "source",
      initial: () => undefined,
      step: (state: unknown) => state,
      output: () => ({ view: undefined, transitions: [] })
    })
    const component = routeTools(child, () => [])
    const projection = machineOf(component)
    const events: ReadonlyArray<Event> = [
      { type: "ToolCalled", callId: "tool-1", name: "write", arguments: {}, turn: "m1", at: 1 },
      { type: "ToolCalled", callId: "tool-2", name: "read", arguments: {}, turn: "m1", at: 2 }
    ]
    const state = events.map((event, index) => eventAt(event, index + 1)).reduce(projection.step, projection.initial())
    const cancellation = { request: "x1", invocation, cause: "requested" as const }

    expect(projection.output(state).interactions?.cancel?.(cancellation).map((transition) => transition.key))
      .toEqual((machineOf(component).output(replayState(machineOf(component), events)).interactions?.cancel?.(cancellation) ?? []).map((transition) => transition.key))
  })

  test("routing reuses the materialized child output", () => {
    let derivations = 0
    const child = defineComponent({
      name: "source",
      initial: () => 0,
      step: (state: unknown) => Number(state) + 1,
      output: () => {
        derivations += 1
        return { view: undefined, transitions: [] }
      }
    })
    const projection = machineOf(routeTools(child, () => []))
    let state = projection.initial()
    state = projection.step(state, { type: "MessageReceived", id: "m1", text: "work", at: 1 } as Event)
    state = projection.step(state, { type: "TextReturned", text: "working", turn: "m1", at: 2 } as Event)
    state = projection.step(state, { type: "TurnCompleted", turn: "m1", output: "done", at: 3 } as Event)
    expect(derivations).toBe(4)
    state = projection.step(state, { type: "ModelCalled", callId: "model-1", turn: "m2", at: 4 } as Event)
    expect(derivations).toBe(5)
    projection.output(state)
    projection.output(state)
    expect(derivations).toBe(5)
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

test("a return or cancellation resolves only its owning pending call", () => {
  const child = defineComponent({ name: "source", initial: () => undefined, step: (state: unknown) => state, output: () => ({ view: undefined, transitions: [] }) })
  const tools = routeTools(child, () => [])
  const events: ReadonlyArray<Event> = [
    { type: "ToolCalled", callId: "7", name: "missing", arguments: {}, turn: "first" },
    { type: "ToolCalled", callId: "7", name: "missing", arguments: {}, turn: "second" }
  ]
  const cancellation = { request: "cancel", invocation: { method: "message", id: "first", epoch: 0 }, cause: "requested" as const }
  expect((machineOf(tools).output(replayState(machineOf(tools), events)).interactions?.cancel?.(cancellation) ?? []).map((transition) => transition.key))
    .toEqual([JSON.stringify([1, "agent.tools", "answer"])])
  const completed = [...events, { type: "ToolReturned", transitionRef: { seq: 1, component: "agent.tools", tag: "answer" }, callId: "7", turn: "first", result: 1 }]
  const state = completed.map((event, index) => eventAt(event, index + 1)).reduce(machineOf(tools).step, machineOf(tools).initial())
  expect(machineOf(tools).output(state).transitions.map((transition) => transition.key))
    .toEqual([JSON.stringify([2, "agent.tools", "answer"])])
})
