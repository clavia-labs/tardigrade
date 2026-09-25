import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import type { ToolOffer } from "../view"
import { testModelData } from "../../testing/model"
import { testMachineOf as machineOf } from "../../../fixtures/component"
import { replayProjection, replayState } from "@clavia/tardigrade-core/projection"
import { expect, expectTypeOf, test } from "bun:test"
import { Effect } from "effect"
import { actor, component, composeComponents } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { enabled as enabledWithoutData, type Transition } from "@clavia/tardigrade-core/runtime"
import { annotateTransition } from "@clavia/tardigrade-core/transition/transition"
import { tools, tool, toolList } from "./index"
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
  tools({ spec: { name: "read", description: "read", inputSchema: {} }, run: () => Effect.succeed({ error: "failed" }) })
const eventsOf = (transitions: ReadonlyArray<Transition<never, unknown>>): ReadonlyArray<Event> =>
  transitions.flatMap((transition) => (transition.kind === "intent" ? transition.events(transition.input, 1) : []))

test("native tool aliases preserve instructions, names, and proposals", () => {
  const binding = { spec: { name: "read", description: "read", inputSchema: {} }, run: () => Effect.succeed("contents") }
  const outputs = [tools, tool, toolList].map(create => {
    const child = create([binding], () => "Read carefully", { name: "reader" })
    expect(child.name).toBe("reader")
    return replayProjection(machineOf(child), [head, called("a")])
  })
  for (const output of outputs) {
    expect(output.view).toEqual(outputs[0]!.view)
    expect(output.view.system).toEqual(["Read carefully"])
    expect(output.transitions.map(work => work.key)).toEqual(outputs[0]!.transitions.map(work => work.key))
  }
})

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
  const child = tools({
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


test("native tools read the full committed log lazily and refresh on each read", async () => {
  const prior: Event = { type: "ToolReturned", callId: "previous", turn: "earlier", result: { wasteAdded: 6 }, at: 1 }
  const snapshot = [head, prior, called("a")]
  let committed: ReadonlyArray<Event> = snapshot
  let reads = 0
  const child = tools({
    spec: { name: "read", description: "read", inputSchema: {} },
    run: (_, { readEvents, callId, signal }) => Effect.gen(function* () {
      expectTypeOf(readEvents()).toEqualTypeOf<Effect.Effect<ReadonlyArray<Event>>>()
      const read = readEvents()
      expect(reads).toBe(0)
      committed = [...snapshot, { type: "Later", at: 2 }]
      const first = yield* read
      expect(first).toMatchObject(committed)
      expect(reads).toBe(1)
      committed = [...committed, { type: "LaterStill", at: 3 }]
      const second = yield* readEvents()
      expect(second).toMatchObject(committed)
      expect(second).toHaveLength(5)
      expect(first).toHaveLength(4)
      expect(reads).toBe(2)
      expect(callId).toBe("a")
      expect(signal.aborted).toBe(false)
      return first.filter(event => event.type === "ToolReturned").length
    })
  })
  const work = replayProjection(machineOf(child), snapshot).transitions[0]!
  if (work.kind !== "effect") throw new Error("expected tool effect")
  expect(reads).toBe(0)
  const result = await Effect.runPromise(work.act(work.input, new AbortController().signal).pipe(
    Effect.provideService(EventLog, withWatermark({
      read: Effect.sync(() => { reads++; return committed }),
      append: () => Effect.die("unexpected append")
    }))
  ))
  expect(result).toMatchObject([{ type: "ToolReturned", callId: "a", result: 1 }])
})

test("native tools that ignore readEvents perform no log reads", async () => {
  const work = replayProjection(machineOf(reader()), [head, called("a")]).transitions[0]!
  if (work.kind !== "effect") throw new Error("expected tool effect")
  const result = await Effect.runPromise(work.act(work.input, new AbortController().signal).pipe(
    Effect.provideService(EventLog, withWatermark({
      read: Effect.die("tool must not read the log"),
      append: () => Effect.die("unexpected append")
    }))
  ))
  expect(result).toMatchObject([{ type: "ToolReturned", result: { error: "failed" } }])
})
