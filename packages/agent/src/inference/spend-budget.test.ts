import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { inferenceFromHistory } from "./machine"
import { budget, spendUsd, toolCalls } from "../component/budget"
import { nativeOutput } from "../component/native-output"
import { renderOf } from "../runtime/composition"
import { CostEvidence } from "@clavia/tardigrade-model/settings"
import { Schema } from "effect"
import type { Projection } from "@clavia/tardigrade-core/projection"
import { replayProjection } from "@clavia/tardigrade-core/projection"

const model = { provider: "openai", model_id: "gpt-test" } as const
const components = [budget({ usd: 0.5 }), nativeOutput]
const render = (events: ReadonlyArray<Event>) => renderOf(components, events)
const derive = inferenceFromHistory({ models: { default: model } }, render)
const head = { type: "MessageReceived", id: "turn", text: "test", at: 1 } as Event
const called = (ordinal: number, pricing?: { promptUsdPerToken: number; completionUsdPerToken: number }): Event => ({
  type: "ModelCalled", callId: `turn/infer/${ordinal}`, ordinal, turn: "turn", model,
  ...(pricing === undefined ? {} : { pricing }), at: ordinal * 2 + 2
}) as Event
const returned = (ordinal: number, options: { reportedCostUsd?: number; cost?: { costUsd?: number; costSource?: "provider" | "table"; reportedCostUsd?: number; estimatedCostUsd?: number }; legacyCostUsd?: number; prompt?: number; completion?: number } = {}): Event => ({
  type: "ModelReturned", callId: `turn/infer/${ordinal}`, ordinal, turn: "turn", outcome: "returned",
  usage: {
    inputTokens: options.prompt === undefined ? {} : { total: options.prompt },
    outputTokens: options.completion === undefined ? {} : { total: options.completion }
  },
  ...(options.legacyCostUsd === undefined ? {} : { legacyUsage: { promptTokens: options.prompt, completionTokens: options.completion, costUsd: options.legacyCostUsd, costSource: "provider" } }),
  ...(options.reportedCostUsd === undefined ? {} : { reportedCostUsd: options.reportedCostUsd }),
  ...(options.cost === undefined ? {} : { cost: options.cost }),
  at: ordinal * 2 + 3
}) as Event

const eventFrom = (history: ReadonlyArray<Event>): Event => {
  const transition = derive(history)[0]!
  expect(transition.kind).toBe("intent")
  if (transition.kind !== "intent") throw new Error("expected terminal intent")
  return transition.events(transition.input, 100)[0]!
}

describe("inference spend budget", () => {
  test("budget usd contributes admission through the public component", () => {
    expect(renderOf([budget({ usd: 0.5 }), nativeOutput], [])).toMatchObject({
      admission: [{ component: "spend-budget" }]
    })
    expect(() => budget({ usd: 0 })).toThrow("spend budget usd must be positive")
    expect(() => Schema.decodeSync(CostEvidence)({ costUsd: -0.1 })).toThrow()
    expect(renderOf([nativeOutput], [])).not.toHaveProperty("admission")
    expect(renderOf([budget([budget({ usd: 0.5 }), nativeOutput], { limit: 1 })], [])).toMatchObject({
      admission: [{ component: "spend-budget" }]
    })
    expect(renderOf([budget([nativeOutput], { limit: 1 })], [])).not.toHaveProperty("admission")
  })

  test("admits the first attempt", () => {
    expect(derive([head])[0]?.kind).toBe("effect")
  })

  test("stops at reported spend without another model call", () => {
    const history = [head, called(0), returned(0, { reportedCostUsd: 0.5, prompt: 10, completion: 2 })]
    const event = eventFrom(history)
    expect(event).toMatchObject({
      type: "TurnFailed",
      cause: "inference_budget_exhausted",
      attempts: 1,
      policy: { usd: 0.5, spentUsd: 0.5, reason: "exhausted" }
    })
    expect(eventFrom(history)).toMatchObject({ cause: event.cause, policy: event.policy })
  })

  test("a final output completes before budget admission is reconsidered", () => {
    const history = [
      head,
      called(0),
      returned(0, { reportedCostUsd: 0.5, prompt: 10, completion: 2 }),
      { type: "TurnCompleted", turn: "turn", output: "done", attemptKey: "turn/infer/0", at: 5 } as Event
    ]
    expect(derive(history)).toEqual([])
  })

  test("sums priced native usage across attempts", () => {
    const pricing = { promptUsdPerToken: 0.01, completionUsdPerToken: 0.05 }
    const history = [head, called(0, pricing), returned(0, { prompt: 10, completion: 2 }), called(1, pricing), returned(1, { prompt: 20, completion: 2 })]
    expect(eventFrom(history)).toMatchObject({
      type: "TurnFailed",
      policy: { usd: 0.5, spentUsd: 0.5, reason: "exhausted" }
    })
  })

  test("stops visibly when returned spend is unknown", () => {
    const failed = {
      ...returned(0), outcome: "failed", error: { message: "busy" }, retry: { index: 0, dueAt: 3 }
    } as Event
    expect(eventFrom([head, called(0), failed])).toMatchObject({
      type: "TurnFailed",
      cause: "inference_budget_exhausted",
      policy: { usd: 0.5, spentUsd: null, reason: "unknown" }
    })
  })

  test("explicit unknown admission preserves the unknown observation", () => {
    const failed = {
      ...returned(0), outcome: "failed", error: { message: "busy" }, retry: { index: 0, dueAt: 3 }
    } as Event
    const admitted = renderOf([budget(spendUsd, { limit: 0.5, onUnknown: "admit" }), nativeOutput], [
      head, called(0), failed
    ])
    expect(admitted.admission).toMatchObject([{
      policy: { constraint: "spendUsd", limit: 0.5, observed: null, onUnknown: "admit", reason: "unknown", admitted: true }
    }])
    expect(inferenceFromHistory({ models: { default: model } }, () => admitted)([head, called(0), failed])[0]?.kind).toBe("effect")
  })

  test("a failed attempt retries when explicit evidence records zero cost", () => {
    const failed = {
      ...returned(0, { cost: { costUsd: 0, costSource: "provider" } }),
      outcome: "failed", error: { message: "busy" }, retry: { index: 0, dueAt: 3 }
    } as Event
    expect(derive([head, called(0), failed])[0]?.kind).toBe("effect")
  })

  test("a plain third projection replays and updates incrementally", () => {
    type State = { readonly turn: string; readonly attempts: number }
    const modelAttempts: Projection<State, number> = {
      initial: () => ({ turn: "", attempts: 0 }),
      step: (state, event) => event.type === "MessageReceived"
        ? { turn: String(event.id), attempts: 0 }
        : event.type === "ModelReturned" && event.turn === state.turn
          ? { ...state, attempts: state.attempts + 1 }
          : state,
      output: (state) => state.attempts
    }
    const history = [head, called(0), returned(0, { reportedCostUsd: 0 })]
    const component = budget(modelAttempts, { limit: 1, name: "modelAttempts" })
    const incremental = history.reduce((state, event) => component.machine.step(state, event), component.machine.initial())
    const cold = renderOf([component, nativeOutput], history).admission
    expect(component.machine.output(incremental).view.admission).toEqual(cold)
    expect(replayProjection(modelAttempts, history)).toBe(1)
    expect(cold).toMatchObject([{
      policy: { constraint: "modelAttempts", observed: 1, reason: "exhausted" },
      blocked: { cause: "inference_budget_exhausted", attempts: 1 }
    }])
    const next = { type: "MessageReceived", id: "next", text: "again", at: 9 } as Event
    const reset = component.machine.step(incremental, next)
    expect(component.machine.output(reset).view.admission).toMatchObject([{ policy: { observed: 0, admitted: true } }])
  })

  test("invalid observations fail both budget surfaces", () => {
    for (const observed of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalid: Projection<undefined, number> = {
        initial: () => undefined,
        step: (state) => state,
        output: () => observed
      }
      expect(() => renderOf([budget(invalid, { limit: 1, name: "invalid" }), nativeOutput], [])).toThrow("finite nonnegative")
      expect(() => renderOf([budget([nativeOutput], invalid, { limit: 1, name: "invalid" })], [])).toThrow("finite nonnegative")
    }
  })

  test("the tool-call projection measures every action supplied to it", () => {
    expect(replayProjection(toolCalls, [
      { type: "ToolCalled", callId: "request", name: "request_budget", arguments: {}, at: 1 } as Event,
      { type: "ToolCalled", callId: "work", name: "read", arguments: {}, at: 2 } as Event
    ])).toBe(2)
  })

  test("explicit unknown cost prevents fallback repricing", () => {
    const pricing = { promptUsdPerToken: 1, completionUsdPerToken: 1 }
    expect(eventFrom([head, called(0, pricing), returned(0, { cost: {}, prompt: 10, completion: 2 })])).toMatchObject({
      type: "TurnFailed",
      policy: { usd: 0.5, spentUsd: null, reason: "unknown" }
    })
  })

  test("explicit unknown cost overrides legacy cost evidence", () => {
    const pricing = { promptUsdPerToken: 1, completionUsdPerToken: 1 }
    expect(eventFrom([head, called(0, pricing), returned(0, { reportedCostUsd: 4, cost: {}, legacyCostUsd: 3, prompt: 10, completion: 2 })])).toMatchObject({
      type: "TurnFailed",
      policy: { usd: 0.5, spentUsd: null, reason: "unknown" }
    })
  })

  test("a new turn starts with an empty observed-spend budget", () => {
    const prior = [
      head,
      called(0),
      returned(0, { reportedCostUsd: 0.5, prompt: 10, completion: 2 }),
      { type: "TurnCompleted", turn: "turn", output: "done", at: 5 } as Event,
      { type: "MessageReceived", id: "next", text: "again", at: 6 } as Event
    ]
    expect(derive(prior)[0]?.kind).toBe("effect")
  })

  test("admits a binding-provided mixed physical-attempt total", () => {
    expect(eventFrom([head, called(0), returned(0, { cost: { costUsd: 0.5, costSource: "table", reportedCostUsd: 0.2, estimatedCostUsd: 0.3 }, prompt: 10, completion: 2 })])).toMatchObject({
      type: "TurnFailed",
      policy: { usd: 0.5, spentUsd: 0.5, reason: "exhausted" }
    })
  })
})
