import type { ToolOffer } from "../view"
import { testModelData } from "@clavia/tardigrade-agent/fixtures/model"
import { testMachineOf as machineOf } from "@clavia/tardigrade-agent/fixtures/component"
import { replayProjection, replayState } from "@clavia/tardigrade-core/projection"
import { expect, expectTypeOf, test } from "bun:test"
import { Effect } from "effect"
import { actor, component, composeComponents } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { enabled as enabledWithoutData, type Transition } from "@clavia/tardigrade-core/runtime"
import { annotateTransition } from "@clavia/tardigrade-core/transition/transition"
import { tool } from "./index"
import { nativeOutput } from "../native-output"
import { agentMethods } from "../../actor/methods"
import { AGENT_VIEW_ALGEBRA, infer } from "../infer/index"
import { toolComponent, toolCallOf, type ToolCallView } from "./machine"

const head: Event = { type: "MessageReceived", id: "turn", text: "go", budget: 1, at: 0 }
const called = (callId: string, name = "read"): Event => ({
  type: "ToolCalled",
  callId,
  name,
  arguments: { path: callId },
  turn: "turn",
  at: 1
})
const reader = () =>
  tool({ spec: { name: "read", description: "read", inputSchema: {} }, run: () => Effect.succeed({ error: "failed" }) })
const eventsOf = (transitions: ReadonlyArray<Transition<never, unknown>>): ReadonlyArray<Event> =>
  transitions.flatMap((transition) => (transition.kind === "intent" ? transition.events(transition.input, 1) : []))

test("tool views expose typed call data and proposals retain their call identity", () => {
  const output = replayProjection(machineOf(reader()), [head, called("a")])
  expectTypeOf(output.view.calls).toEqualTypeOf<ReadonlyArray<ToolCallView>>()
  expectTypeOf(output.view.pendingCalls).toEqualTypeOf<ReadonlyArray<ToolCallView>>()
  expect(output.view).toMatchObject({
    calls: [{ callId: "a", name: "read", arguments: { path: "a" }, turn: "turn" }],
    pendingCalls: [{ callId: "a", name: "read", arguments: { path: "a" }, turn: "turn" }]
  })
  expect(output.view.tools[0]).not.toHaveProperty("serve")
  expect(Object.keys(output.interactions!)).toEqual(["cancel"])
  expect(output.transitions).toHaveLength(1)
  expect(toolCallOf(output.transitions[0]!)).toMatchObject({ position: 2, callId: "a", turn: "turn" })
})

test("settlement preserves call identity across decoration and replay without running the tool", () => {
  let executions = 0
  const child = tool({
    spec: { name: "read", description: "read", inputSchema: {} },
    run: () =>
      Effect.sync(() => {
        executions += 1
        return "read"
      })
  })
  const log = [head, { ...called("a"), epoch: 3 }]
  const state = replayState(machineOf(child), log)
  const proposal = machineOf(child).output(state).transitions[0]!
  const decorated = annotateTransition(proposal, Symbol("policy"), "denied")
  const completion = decorated.respond!({ error: "denied" })
  const returned = completion.events(completion.input, 2)
  expect(returned).toMatchObject([{ type: "ToolReturned", callId: "a", turn: "turn", result: { error: "denied" } }])
  expect(
    machineOf(child).output(replayState(machineOf(child), log)).transitions[0]!.respond!({ error: "denied" }).key
  ).toBe(completion.key)
  expect(machineOf(child).output(state).view.pendingCalls).toHaveLength(1)
  expect(machineOf(child).output(replayState(machineOf(child), [...log, ...returned])).transitions).toEqual([])
  expect(executions).toBe(0)
})

test("a parent can block admission without infer bypassing it", () => {
  const child = composeComponents("hold", AGENT_VIEW_ALGEBRA, [reader()], { reconcile: () => [] })
  const root = actor({
    name: "test",
    methods: agentMethods,
    components: [
      infer([child, nativeOutput], { models: { default: { provider: "test", model_id: "test" }, allow: "*" } })
    ]
  })
  expect(enabled(root, [head, called("a")])).toEqual([])
})

test("a parent's final tool view determines which requests were offered", () => {
  const source = reader()
  const child = component({
    name: "hide",
    children: source,
    initial: () => undefined,
    step: () => undefined,
    output: (_state, child) => {
      const output = child.output()
      return { ...output, view: { ...output.view, tools: [] } }
    }
  })
  const root = infer([child, nativeOutput], { models: { default: { provider: "test", model_id: "test" }, allow: "*" } })
  const output = replayProjection(machineOf(root), [
    head,
    { type: "ModelCalled", callId: "model", turn: "turn" },
    called("a")
  ], testModelData)
  const proposed = eventsOf(output.transitions)
  expect(proposed).toContainEqual(
    expect.objectContaining({ type: "ToolReturned", result: { error: expect.stringContaining("unknown tool") } })
  )
})

test("an owned dynamic tool retains the binding offered before its view changes", () => {
  const offer: ToolOffer = {
    spec: { name: "read", description: "once", inputSchema: {} },
    serve: (_call, _log, answer) => [answer("original")]
  }
  const child = toolComponent(
    component({
      name: "dynamic",
      initial: () => false,
      step: (hidden, event) => hidden || event.type === "ToolCalled",
      output: (hidden) => ({
        transitions: [],
        view: { ...AGENT_VIEW_ALGEBRA.empty, tools: hidden ? [] : [{ spec: offer.spec }] },
        interactions: { tools: () => (hidden ? [] : [offer]) }
      })
    })
  )
  const log = [head, { type: "ModelCalled", callId: "model", turn: "turn" }, called("a")]
  const output = replayProjection(machineOf(child), log)
  expect(output.view.tools).toEqual([])
  expect(eventsOf(output.transitions)).toContainEqual(
    expect.objectContaining({ type: "ToolReturned", result: "original" })
  )
})

const enabled: typeof enabledWithoutData = (actor, events, data = testModelData) =>
  enabledWithoutData(actor, events, data)
