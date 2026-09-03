import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { actor } from "@clavia/tardigrade-core/actor"
import { Self, enabled, settleActor } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { threadAddressOf, parseThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { Infer } from "../runtime/turn"
import { NativeOutputSupport } from "../inference/contract"
import { budget, budgetOf, budgetPhase, budgetSpent, caller, canRequestBudget } from "./budget"
import { infer, renderOf } from "../runtime/composition"
import { codeMode } from "./code"
import { compaction } from "./compaction"
import { agentMethods } from "../actor/methods"
import { nativeOutput } from "./native-output"
import { tool } from "./tool"
import { agentKeys } from "../log/events"

const TEST_MODEL = { models: { default: { provider: "test", model_id: "test-model" }, allow: "*" } } as const

const assembled = <R>(component: import("../runtime/composition").AgentComponent<R>) => actor({
  name: "test-agent",
  methods: agentMethods,
  components: [component]
})

const rootActor = assembled(infer([budget([codeMode()]), compaction(), nativeOutput], TEST_MODEL))
const rootReactor = (events: ReadonlyArray<Event>) => enabled(rootActor, events)

// rest supplies the environment required by effect transitions in this assembled agent.
const rest = Layer.mergeAll(
  KeyValueStore.layerMemory,
  Layer.succeed(Router, {
    send: () => Effect.void
  }),
  Layer.succeed(Self, parseThreadAddress("test-agent:main:main")),
  Layer.succeed(NativeOutputSupport, { withTools: true }),
  Layer.succeed(Infer, { react: () => Effect.die("the budget guard never asks the model") })
)

// turn builds a budgeted trajectory whose final execute call is unanswered.
const turn = (calls: number, budget?: number, extra: Event[] = []): Event[] => {
  const id = "m1"
  const log: Event[] = [{ type: "MessageReceived", id, text: "go", ...(budget === undefined ? {} : { budget }), at: 0 }]
  for (let i = 1; i <= calls; i++) {
    log.push({ type: "ToolCalled", callId: `c${i}`, name: "execute", arguments: { code: `x${i}` }, turn: id, at: i * 2 })
    if (i < calls) log.push({ type: "ToolReturned", callId: `c${i}`, result: {}, turn: id, at: i * 2 + 1 })
  }
  return [...log, ...extra]
}

describe("budget admission reacts to BudgetExhausted", () => {
  // dispatch runs the first transition and returns its events.
  const dispatch = async (log: ReadonlyArray<Event>): Promise<ReadonlyArray<Event>> => {
    const events: Event[] = [...log]
    const memory = Layer.succeed(EventLog, withWatermark({
      append: (more: ReadonlyArray<Event>) => Effect.sync(() => void events.push(...more)),
      read: Effect.sync(() => events as ReadonlyArray<Event>)
    }))
    const derived = rootReactor(events)
    if (derived.length > 0) {
      const transition = derived[0]!
      const out = transition.kind === "intent"
        ? transition.events(transition.input, 0)
        : await Effect.runPromise(
            transition.act(transition.input, new AbortController().signal).pipe(Effect.provide(Layer.mergeAll(memory, rest)))
          )
      events.push(...out)
    }
    return events.slice(log.length)
  }

  test("with no wall on the turn, execute dispatches", async () => {
    const out = await dispatch(turn(2, 12))
    expect(out[0]!.type).toBe("CodeDispatched")
  })

  test("admission commits an intent before code execution becomes an effect", () => {
    const log = turn(1, 12)
    const admission = rootReactor(log).find((transition) => transition.key === "cd:c1")
    expect(admission?.kind).toBe("intent")
    const execution = rootReactor([
      ...log,
      { type: "CodeDispatched", execId: "c1", code: "x1", turn: "m1", at: 3 }
    ]).find((transition) => transition.key === "cs:c1")
    expect(execution?.kind).toBe("effect")
  })

  test("the exported default and a turn override decide the wall", () => {
    const defaultTwoActor = actor({
      name: "default-two",
      methods: agentMethods,
      components: [infer([budget([codeMode()], { limit: 2 }), nativeOutput], TEST_MODEL)]
    })
    const defaultTwo = (events: ReadonlyArray<Event>) => enabled(defaultTwoActor, events)

    expect(defaultTwo(turn(2)).some((transition) => transition.key.startsWith("bw:"))).toBe(false)
    expect(defaultTwo(turn(3)).map((transition) => transition.key)).toContain("bw:m1/2")
    expect(defaultTwo(turn(3, 9)).some((transition) => transition.key.startsWith("bw:"))).toBe(false)
    expect(budgetOf(turn(1), { limit: 2 })).toBe(2)
    expect(budgetOf(turn(1, 9), { limit: 2 })).toBe(9)
  })

  test("the limit is a positive whole number", () => {
    expect(() => budget([codeMode()], { limit: 0 })).toThrow("budget limit must be a positive integer")
    expect(() => budget([codeMode()], { limit: 1.5 })).toThrow("budget limit must be a positive integer")
  })

  test("the first call past the limit derives the wall without deriving dispatch", () => {
    const keys = rootReactor(turn(3, 2)).map((transition) => transition.key)

    expect(keys).toContain("bw:m1/2")
    expect(keys).not.toContain("cd:c3")
  })

  test("settling an over-budget execute records the wall and never dispatches the call", async () => {
    const initial = turn(3, 2)
    const events: Event[] = [...initial]
    const memory = Layer.succeed(EventLog, withWatermark({
      append: (more: ReadonlyArray<Event>) => Effect.sync(() => void events.push(...more)),
      read: Effect.sync(() => events as ReadonlyArray<Event>)
    }))
    const environment = Layer.mergeAll(
      memory,
      KeyValueStore.layerMemory,
      Layer.succeed(Router, { send: () => Effect.void }),
      Layer.succeed(Self, parseThreadAddress("test-agent:main:main")),
      Layer.succeed(NativeOutputSupport, { withTools: true }),
      Layer.succeed(Infer, { react: () => Effect.succeed({ kind: "complete" as const, output: "done" }) })
    )

    await Effect.runPromise(settleActor(rootActor).pipe(Effect.provide(environment)))

    expect(events).toContainEqual(expect.objectContaining({
      type: "BudgetExhausted",
      budget: 2,
      used: 3,
      turn: "m1"
    }))
    expect(events.some(
      (event) => event.type === "CodeDispatched" && String((event as { execId?: unknown }).execId) === "c3"
    )).toBe(false)
  })

  test("the wall records the applied limit and observed demand", async () => {
    const log = turn(3, 2)
    const wall = rootReactor(log).find((transition) => transition.key === "bw:m1/2")!
    expect(wall.kind).toBe("intent")
    if (wall.kind !== "intent") throw new Error("budget wall must be an intent")
    const emitted = wall.events(wall.input, 0)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1" })
    expect(rootReactor([...log, ...emitted]).some((transition) => transition.key.startsWith("bw:"))).toBe(false)
  })

  test("the admission fold reads neither clock nor randomness", () => {
    const realNow = Date.now
    const realRandom = Math.random
    Date.now = () => {
      throw new Error("clock in the budget guard")
    }
    Math.random = () => {
      throw new Error("random in the budget guard")
    }
    try {
      expect(rootReactor(turn(3, 2)).map((transition) => transition.key)).toContain("bw:m1/2")
    } finally {
      Date.now = realNow
      Math.random = realRandom
    }
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

  test("a non-code child is admitted by the same tool-call policy", () => {
    const definition = assembled(infer([budget([readTool], { limit: 1 }), nativeOutput], TEST_MODEL))
    const root = (events: ReadonlyArray<Event>) => enabled(definition, events)
    const log: Event[] = [
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      { type: "ToolCalled", callId: "r1", name: "read", arguments: {}, turn: "m1", at: 1 },
      { type: "ToolReturned", callId: "r1", result: "ok", turn: "m1", at: 2 },
      { type: "ToolCalled", callId: "r2", name: "read", arguments: {}, turn: "m1", at: 3 }
    ]

    expect(root(log).map((transition) => transition.key)).toContain("bw:m1/1")
  })

  test("a wall withdraws only tools inside the budget subtree", () => {
    const log = turn(3, 2, [{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 99 }])
    const rendered = renderOf([budget([codeMode()]), readTool, nativeOutput], log)

    expect(rendered.tools.map((tool) => tool.name)).toEqual(["read"])
  })

  test("a wall has no global effect without a budget component", () => {
    const log = turn(3, 2, [{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 99 }])
    const rendered = renderOf([codeMode(), nativeOutput], log)

    expect(rendered.tools.map((tool) => tool.name)).toEqual(["execute"])
    expect(rendered.system).not.toContain("tool budget for this turn is spent")
  })
})

// exhausted records the wall used by escalation lifecycle tests.
const exhausted: Event = { type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 100 }
const granted = (amount: number): Event => ({ type: "BudgetGranted", amount, turn: "m1", at: 101 })
const denied: Event = { type: "BudgetDenied", reason: "no", turn: "m1", at: 101 }

describe("the escalation lifecycle", () => {
  test("a grant and denial for one request share a decision key", () => {
    const grant: Event = { type: "BudgetGranted", amount: 2, callId: "request-1", turn: "m1", at: 1 }
    const denial: Event = { type: "BudgetDenied", reason: "no", callId: "request-1", turn: "m1", at: 2 }
    expect(agentKeys.keyOf(grant)).toBe("bdec:request-1")
    expect(agentKeys.keyOf(denial)).toBe("bdec:request-1")
  })

  test("a budget with no authority sends no manually recorded request", () => {
    const head: Event = { type: "MessageReceived", id: "m1", text: "go", budget: 2, escalatable: true, at: 0 }
    const requested: Event = {
      type: "BudgetRequested",
      callId: "request-1",
      reason: "one source remains",
      amount: 2,
      turn: "m1",
      at: 3
    }

    const keys = rootReactor([head, exhausted, requested]).map((transition) => transition.key)
    expect(keys.some((key) => key.startsWith("mcall:"))).toBe(false)
    expect(keys.some((key) => key.startsWith("bas:"))).toBe(false)
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
    expect(renderOf([budget([codeMode()]), nativeOutput], log).tools.map((tool) => tool.name)).toEqual(["execute"])
    // rendered exposes execute after a grant and withdraws it after exhaustion or denial.
    expect(budgetSpent(turn(3, 2, [exhausted]))).toBe(true)
    expect(budgetSpent(log)).toBe(false)
    expect(budgetSpent(turn(3, 2, [exhausted, denied]))).toBe(true)
  })

  test("the ask is offered only when escalatable and only at the wall", () => {
    const head = (escalatable: boolean): Event => ({ type: "MessageReceived", id: "m1", text: "go", budget: 2, escalatable, at: 0 })
    const atWall = (escalatable: boolean): Event[] => [head(escalatable), ...turn(3, 2, [exhausted]).slice(1)]
    expect(canRequestBudget(atWall(true))).toBe(true)
    expect(canRequestBudget(atWall(false))).toBe(false) // not escalatable: no ask
    const afterDenial = [head(true), ...turn(3, 2, [exhausted, denied]).slice(1)]
    expect(canRequestBudget(afterDenial)).toBe(false) // denied: answer, do not ask again
  })

  test("the authority option exposes the request tool through an accepted actor call", () => {
    const source = threadAddressOf("agent", "main", "parent")
    const target = threadAddressOf("agent", "main", "child")
    const head: Event = {
      type: "MessageReceived",
      id: "m1",
      text: "go",
      budget: 2,
      escalatable: true,
      link: linkOf(source, target),
      at: 0
    }
    const atWall = [head, ...turn(3, 2, [exhausted]).slice(1)]

    expect(renderOf([budget([codeMode()]), nativeOutput], atWall).tools).toEqual([])
    expect(renderOf([budget([codeMode()], { authority: caller() }), nativeOutput], atWall).tools.map((tool) => tool.name)).toEqual([
      "request_budget"
    ])
  })
})
