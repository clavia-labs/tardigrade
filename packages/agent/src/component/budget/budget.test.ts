import { renderOf } from "../../runtime/render"
import { testModelData } from "@clavia/tardigrade-agent/fixtures/model"
import { testMachineOf as machineOf } from "@clavia/tardigrade-agent/fixtures/component"
import type { ToolState } from "../tool/machine"
import { replayState } from "@clavia/tardigrade-core/projection"
import { testInferenceLayer } from "@clavia/tardigrade-agent/fixtures/model"
import { describe, expect, expectTypeOf, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { actor, component, withResponse } from "@clavia/tardigrade-core/actor"
import { Self, enabled as enabledWithoutData, settleActor, type Transition } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"

import { NativeOutputSupport } from "../../model/contract"
import { budget, budgetOf, budgetPhase, budgetSpent, DEFAULT_BUDGET_POLICY, type BudgetOptions } from "./index"
import { AGENT_VIEW_ALGEBRA, infer } from "../infer/index"
import { codeMode } from "../code/index"
import { agentMethods } from "../../actor/methods"
import { nativeOutput } from "../native-output"
import { tool } from "../tool/index"
import type { TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { eventAt } from "@clavia/tardigrade-core/event"
import { agentKeys } from "../../log/events"

const TEST_MODEL = { models: { default: { provider: "test", model_id: "test-model" }, allow: "*" } } as const

const assembled = <R>(component: import("../infer/index").AgentComponent<R>) =>
  actor({
    name: "test-agent",
    methods: agentMethods,
    components: [component]
  })

const toolBudgetOptions = {
  onExhausted: (reason, settle) => settle({ error: reason }),
  usage: (observation) => observation.calls.length,
  rejectionMessage: "Tool budget reached. Answer now with your best result.",
  view: (view, state) =>
    state.phase === "spending"
      ? view
      : {
          ...view,
          tools: [],
          system: [...view.system, "Your tool budget is spent. Answer now with what you have."]
        }
} satisfies BudgetOptions<import("../view").AgentView & ToolState>

const rootActor = assembled(
  infer(
    [budget(codeMode(), toolBudgetOptions), nativeOutput],
    TEST_MODEL
  )
)
const rootReactor = (events: ReadonlyArray<Event>) => enabled(rootActor, events)

const proposedEvents = (transitions: ReadonlyArray<Transition<never, unknown>>): ReadonlyArray<Event> =>
  transitions.flatMap((transition) => (transition.kind === "intent" ? transition.events(transition.input, 0) : []))

// rest supplies the environment required by effect transitions in this assembled agent.
const rest = Layer.mergeAll(
  Layer.succeed(ThreadAllocator, { allocate: () => Effect.die(new Error("unexpected child allocation")) }),
  KeyValueStore.layerMemory,
  Layer.succeed(Router, {
    send: () => Effect.void
  }),
  Layer.succeed(Self, parseThreadAddress("test-agent:main:main")),
  Layer.succeed(NativeOutputSupport, { withTools: true }),
  testInferenceLayer({ react: () => Effect.die("the budget guard never asks the model") })
)

// turn builds a budgeted trajectory whose final execute call is unanswered.
const turn = (calls: number, budget?: number, extra: Event[] = []): Event[] => {
  const id = "m1"
  const log: Event[] = [{ type: "MessageReceived", id, text: "go", ...(budget === undefined ? {} : { budget }), at: 0 }]
  log.push({ type: "BudgetGranted", initial: true, amount: budget ?? DEFAULT_BUDGET_POLICY.limit, turn: id, at: 1 })
  for (let i = 1; i <= calls; i++) {
    log.push({
      type: "ToolCalled",
      callId: `c${i}`,
      name: "execute",
      arguments: { code: `x${i}` },
      turn: id,
      at: i * 2
    })
    if (i < calls) log.push({ type: "ToolReturned", transitionRef: { seq: log.length, component: "tools", tag: "answer" }, callId: `c${i}`, result: {}, turn: id, at: i * 2 + 1 })
  }
  return [...log, ...extra]
}

describe("budget public state", () => {
  test("a parent consumes the applied allowance and admitted usage", () => {
    const child = budget(codeMode(), { ...toolBudgetOptions, limit: 2 })
    const parent = component({
      name: "observer",
      children: child,
      initial: () => undefined,
      step: (state) => state,
      output: (_state, child) => {
        const state = child.output().view
        expectTypeOf(state.used).toEqualTypeOf<number>()
        return { view: { remaining: state.remaining, used: state.used }, transitions: [] }
      }
    })
    expect(machineOf(child).output(replayState(machineOf(child), turn(3, 2))).view).toMatchObject({
      limit: 2,
      used: 2,
      remaining: 0,
      phase: "spending"
    })
    expect(machineOf(parent).output(replayState(machineOf(parent), turn(3, 2))).view).toEqual({ remaining: 0, used: 2 })
  })


})

describe("budget admission reacts to BudgetExhausted", () => {
  // dispatch runs the first transition and returns its events.
  const dispatch = async (log: ReadonlyArray<Event>): Promise<ReadonlyArray<Event>> => {
    const events: Event[] = [...log]
    const memory = Layer.succeed(
      EventLog,
      withWatermark({
        append: (more: ReadonlyArray<Event>) => Effect.sync(() => void events.push(...more)),
        read: Effect.sync(() => events as ReadonlyArray<Event>)
      })
    )
    const derived = rootReactor(events)
    if (derived.length > 0) {
      const transition = derived[0]!
      const out =
        transition.kind === "intent"
          ? transition.events(transition.input, 0)
          : await Effect.runPromise(
              transition
                .act(transition.input, new AbortController().signal)
                .pipe(Effect.provide(Layer.mergeAll(memory, rest)))
            )
      events.push(...out)
    }
    return events.slice(log.length)
  }

  test("with no wall on the turn, execute dispatches", async () => {
    const log = turn(2, 12)
    const admitted = await dispatch(log)
    expect(admitted[0]!.type).toBe("CodeDispatched")
  })

  test("admission commits an intent before code execution becomes an effect", () => {
    const log = turn(1, 12)
    const accepted = log
    const dispatch = rootReactor(accepted).find((transition) =>
      proposedEvents([transition]).some((event) => event.type === "CodeDispatched")
    )
    expect(dispatch?.kind).toBe("intent")
    const execution = rootReactor([...accepted, ...proposedEvents(dispatch === undefined ? [] : [dispatch])]).find(
      (transition) => transition.kind === "effect"
    )
    expect(execution?.kind).toBe("effect")
  })

  test("the exported default and a turn override decide the wall", () => {
    const defaultTwoActor = actor({
      name: "default-two",
      methods: agentMethods,
      components: [infer([budget(codeMode(), { ...toolBudgetOptions, limit: 2 }), nativeOutput], TEST_MODEL)]
    })
    const defaultTwo = (events: ReadonlyArray<Event>) => enabled(defaultTwoActor, events)

    expect(
      proposedEvents(defaultTwo(turn(2).filter((event) => event.type !== "BudgetGranted"))).some(
        (event) => event.type === "BudgetExhausted"
      )
    ).toBe(false)
    expect(proposedEvents(defaultTwo(turn(3).filter((event) => event.type !== "BudgetGranted")))).toContainEqual(
      expect.objectContaining({ type: "BudgetExhausted" })
    )
    expect(proposedEvents(defaultTwo(turn(3, 9))).some((event) => event.type === "BudgetExhausted")).toBe(false)
    expect(
      budgetOf(
        turn(1).filter((event) => event.type !== "BudgetGranted"),
        { limit: 2 }
      )
    ).toBe(2)
    expect(budgetOf(turn(1, 9), { limit: 2 })).toBe(9)
  })

  test("the limit accepts fractional units and rejects invalid amounts", () => {
    expect(() => budget(codeMode(), { ...toolBudgetOptions, limit: 0.05 })).not.toThrow()
    for (const limit of [0, -1, Infinity, NaN]) {
      expect(() => budget(codeMode(), { ...toolBudgetOptions, limit })).toThrow(
        "budget limit must be a positive finite number"
      )
    }
  })

  test("the first call past the limit derives the wall without deriving dispatch", () => {
    const events = proposedEvents(rootReactor(turn(3, 2)))
    expect(events).toContainEqual(expect.objectContaining({ type: "BudgetExhausted" }))
    expect(events.some((event) => event.type === "CodeDispatched")).toBe(false)
  })

  test("settling an over-budget execute records the wall and never dispatches the call", async () => {
    const initial = turn(3, 2)
    const events: Event[] = [...initial]
    const memory = Layer.succeed(
      EventLog,
      withWatermark({
        append: (more: ReadonlyArray<Event>) => Effect.sync(() => void events.push(...more)),
        read: Effect.sync(() => events as ReadonlyArray<Event>)
      })
    )
    const environment = Layer.mergeAll(
      Layer.succeed(ThreadAllocator, { allocate: () => Effect.die(new Error("unexpected child allocation")) }),
      memory,
      KeyValueStore.layerMemory,
      Layer.succeed(Router, { send: () => Effect.void }),
      Layer.succeed(Self, parseThreadAddress("test-agent:main:main")),
      Layer.succeed(NativeOutputSupport, { withTools: true }),
      testInferenceLayer({ react: () => Effect.succeed({ kind: "complete" as const, output: "done" }) })
    )

    await Effect.runPromise(settleActor(rootActor).pipe(Effect.provide(environment)))

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "BudgetExhausted",
        budget: 2,
        used: 3,
        turn: "m1"
      })
    )
    expect(
      events.some((event) => event.type === "CodeDispatched" && String((event as { execId?: unknown }).execId) === "c3")
    ).toBe(false)
  })

  test("the wall records the applied limit and observed demand", async () => {
    const log = turn(3, 2)
    const wall = rootReactor(log).find((transition) =>
      proposedEvents([transition]).some((event) => event.type === "BudgetExhausted")
    )!
    expect(wall.kind).toBe("intent")
    if (wall.kind !== "intent") throw new Error("budget wall must be an intent")
    const emitted = wall.events(wall.input, 0)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1" })
    expect(proposedEvents(rootReactor([...log, ...emitted])).some((event) => event.type === "BudgetExhausted")).toBe(
      false
    )
  })

  test("once BudgetExhausted is on the turn, the work tool is refused with an answer nudge", async () => {
    const log = turn(3, 2, [{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 99 }])
    const out = await dispatch(log)
    expect(out[0]!.type).toBe("ToolReturned")
    const refusal = String((out[0] as { result?: { error?: string } }).result?.error)
    expect(refusal).toContain("Tool budget reached")
    expect(refusal).toContain("Answer now")
  })
})

describe("the budget component boundary", () => {
  const readTool = tool([
    { spec: { name: "read", description: "read", inputSchema: {} }, run: () => Effect.succeed("ok") }
  ])

  test("a wall withdraws only tools inside the budget subtree", () => {
    const log = turn(3, 2, [{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 99 }])
    const rendered = renderOf([budget(codeMode(), toolBudgetOptions), readTool, nativeOutput], log)

    expect(rendered.tools.map((tool) => tool.name)).toEqual(["read"])
  })

  test("a wall has no global effect without a budget component", () => {
    const log = turn(3, 2, [{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 99 }])
    const rendered = renderOf([codeMode(), nativeOutput], log)

    expect(rendered.tools.map((tool) => tool.name)).toEqual(["execute"])
    expect(rendered.system).not.toContain("tool budget for this turn is spent")
  })
})

// exhausted records the wall used by budget lifecycle tests.
const exhausted: Event = { type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 100 }
const granted = (amount: number): Event => ({ type: "BudgetGranted", amount, turn: "m1", at: 101 })
const denied: Event = { type: "BudgetDenied", reason: "no", turn: "m1", at: 101 }

describe("budget lifecycle", () => {
  test("an initial grant replaces the implicit allowance and has a turn key", () => {
    const head: Event = { type: "MessageReceived", id: "m1", text: "work", budget: 99, at: 0 }
    const grant: Event = { type: "BudgetGranted", turn: "m1", initial: true, amount: 2, at: 1 }
    expect(budgetOf([head, grant, granted(3)], { limit: 100 })).toBe(5)
    expect(agentKeys.keyOf(grant)).toBe("bi:m1")
    expect(agentKeys.keyOf({ ...grant, amount: 100, at: 2 })).toBe("bi:m1")
    expect(agentKeys.keyOf({ ...grant, turn: "m2" })).toBe("bi:m2")
  })

  test("a grant and denial for one request share a decision key", () => {
    const grant: Event = { type: "BudgetGranted", amount: 2, callId: "request-1", turn: "m1", at: 1 }
    const denial: Event = { type: "BudgetDenied", reason: "no", callId: "request-1", turn: "m1", at: 2 }
    expect(agentKeys.keyOf(grant)).toBe("bdec:request-1")
    expect(agentKeys.keyOf(denial)).toBe("bdec:request-1")
  })

  test("budget alone does not escalate a recorded request", () => {
    const head: Event = { type: "MessageReceived", id: "m1", text: "go", budget: 2, escalatable: true, at: 0 }
    const requested: Event = {
      type: "BudgetRequested",
      callId: "request-1",
      reason: "one source remains",
      amount: 2,
      turn: "m1",
      at: 3
    }

    const child = budget(codeMode(), toolBudgetOptions)
    const output = machineOf(child).output(replayState(machineOf(child), [head, exhausted, requested]))
    expect(output.view.tools).toEqual([])
    expect(output.transitions.every((transition) => transition.kind === "intent")).toBe(true)
    expect(proposedEvents(output.transitions).map((event) => event.type)).toEqual(["BudgetGranted"])
  })

  test("budgetPhase reads the most recent marker", () => {
    expect(budgetPhase(turn(2, 5))).toBe("spending")
    expect(budgetPhase(turn(3, 2, [exhausted]))).toBe("exhausted")
    expect(budgetPhase(turn(3, 2, [exhausted, granted(5)]))).toBe("spending")
    expect(budgetPhase(turn(3, 2, [exhausted, denied]))).toBe("denied")
  })

  test("a grant raises the ceiling, so budgetOf grows and the machine reopens", () => {
    const log = turn(3, 2, [exhausted, granted(5)])
    expect(budgetOf(log)).toBe(7) // base 2 + grant 5
    expect(renderOf([budget(codeMode(), toolBudgetOptions), nativeOutput], log).tools.map((tool) => tool.name)).toEqual(
      ["execute"]
    )
    // rendered exposes execute after a grant and withdraws it after exhaustion or denial.
    expect(budgetSpent(turn(3, 2, [exhausted]))).toBe(true)
    expect(budgetSpent(log)).toBe(false)
    expect(budgetSpent(turn(3, 2, [exhausted, denied]))).toBe(true)
  })
})

test("rejection preserves committed child events and unrelated sibling work", () => {
  const requests = component({
    name: "requests",
    initial: () => ({ count: 0, pending: undefined as TransitionContext | undefined }),
    step: (state, event, context) =>
      event.type === "ToolCalled"
        ? { count: state.count + 1, pending: context }
        : event.type === "RequestRecorded"
          ? { ...state, pending: undefined }
          : state,
    output: (state) => ({
      view: {
        ...AGENT_VIEW_ALGEBRA.empty,
        system: [`requests:${state.count}`],
        used: state.count
      },
      transitions:
        state.pending === undefined
          ? []
          : [state.pending.intent("record", { type: "RequestRecorded", count: state.count })]
    })
  })
  const work = tool({ spec: { name: "read", description: "Read", inputSchema: {} }, run: () => Effect.succeed("ok") })
  const children = component({
    name: "children",
    children: [work, requests] as const,
    initial: () => undefined,
    step: (state) => state,
    output: (_state, [work, requests]) => ({
      view: {
        ...AGENT_VIEW_ALGEBRA.combine(work.output().view, requests.output().view),
        calls: work.output().view.calls,
        pendingCalls: work.output().view.pendingCalls
      },
      transitions: [...work.output().transitions, ...requests.output().transitions]
    })
  })
  const governed = budget(children, {
    limit: 1,
    onExhausted: (reason, settle) => settle({ error: reason }),
    usage: (observation) => observation.calls.length
  })
  const log: ReadonlyArray<Event> = [
    { type: "MessageReceived", id: "t", text: "go" },
    { type: "ToolCalled", callId: "first", name: "read", arguments: {}, turn: "t" },
    { type: "ToolCalled", callId: "second", name: "read", arguments: {}, turn: "t" }
  ]
  let incremental = machineOf(governed).initial()
  for (const [index, event] of log.entries())
    incremental = machineOf(governed).step(incremental, eventAt(event, index + 1))
  const replayed = replayState(machineOf(governed), log)
  for (const state of [incremental, replayed]) {
    const output = machineOf(governed).output(state)
    expect(output.view).toMatchObject(machineOf(children).output(replayState(machineOf(children), log)).view)
    expect(output.view.system).toContain("requests:2")
    expect(proposedEvents(output.transitions)).toContainEqual(
      expect.objectContaining({ type: "RequestRecorded", count: 2 })
    )
    expect(proposedEvents(output.transitions)).toContainEqual(
      expect.objectContaining({ type: "ToolReturned", callId: "second" })
    )
    expect(output.transitions.filter((transition) => transition.kind === "effect")).toHaveLength(1)
    expect(machineOf(governed).output(state).view.used).toBe(1)
  }
})

test("committed usage is retained even when no operation can be refused", () => {
  const child = component({
    name: "meter",
    initial: () => 0,
    step: (state, event) => (event.type === "UsageRecorded" ? state + Number(event.amount) : state),
    output: (state) => ({
      view: {
        ...AGENT_VIEW_ALGEBRA.empty,
        system: [`used:${state}`],
        used: state
      },
      transitions: []
    })
  })
  const governed = budget(child, {
    limit: 1,
    onExhausted: (reason, settle) => settle({ error: reason }),
    usage: ({ used }) => used
  })
  const state = replayState(machineOf(governed), [{ type: "UsageRecorded", amount: 2 }])
  expect(machineOf(governed).output(state).view.system).toEqual(["used:2"])
  expect(machineOf(governed).output(state).view).toMatchObject({ used: 2, remaining: 0 })
})

const enabled: typeof enabledWithoutData = (actor, events, data = testModelData) =>
  enabledWithoutData(actor, events, data)

test("budget defers dependency initialization until activation", () => {
  const governed = budget(infer([nativeOutput], TEST_MODEL), {
    limit: 1,
    usage: () => 0,
    onExhausted: () => undefined
  })
  const machine = machineOf(governed)
  expect(() => machine.initial(Context.empty())).toThrow("ModelLock")
  const state = machine.initial(testModelData)
  expect(machine.output(state).view).toMatchObject({ used: 0, remaining: 1 })
})

test("budget options adapt a non-tool operation and its typed result", () => {
  const child = component({
    name: "jobs",
    initial: () => ({
      count: 0,
      pending: [] as ReadonlyArray<{ readonly job: string; readonly context: TransitionContext }>
    }),
    step: (state, event, context) =>
      event.type === "JobRequested"
        ? { count: state.count + 1, pending: [...state.pending, { job: String(event.job), context }] }
        : event.type === "JobFinished"
          ? { ...state, pending: state.pending.filter((job) => job.job !== event.job) }
          : state,
    output: (state) => ({
      view: {
        ...AGENT_VIEW_ALGEBRA.empty,
        count: state.count
      },
      transitions: state.pending.map(({ job, context }) =>
        withResponse(context.intent("execute", { type: "JobExecuted", job }), (result: { readonly failure: string }) =>
          context.intent("complete", { type: "JobFinished", job, result })
        )
      )
    })
  })
  const governed = budget(child, {
    limit: 1,
    usage: (observation) => observation.count,
    onExhausted: (reason, settle) => {
      expectTypeOf<Parameters<typeof settle>[0]>().toEqualTypeOf<{ readonly failure: string }>()
      return settle({ failure: reason })
    }
  })
  const output = machineOf(governed).output(replayState(machineOf(governed), [
    { type: "MessageReceived", id: "turn", text: "go", budget: 1 },
    { type: "JobRequested", job: "a" },
    { type: "JobRequested", job: "b" }
  ]))
  const events = proposedEvents(output.transitions)
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "JobFinished",
      job: "b",
      result: { failure: expect.stringContaining("Budget exhausted") }
    })
  )
  expect(events.filter((event) => event.type === "JobExecuted").map((event) => event.job)).toEqual(["a"])
})
