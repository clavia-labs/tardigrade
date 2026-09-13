import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { inferenceFromHistory } from "./machine"
import { budget } from "../component/budget"
import { nativeOutput } from "../component/native-output"
import { renderOf } from "../runtime/composition"
import { CostEvidence } from "@clavia/tardigrade-model/settings"
import { Schema } from "effect"

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
    expect(eventFrom([head, called(0), returned(0)])).toMatchObject({
      type: "TurnFailed",
      cause: "inference_budget_exhausted",
      policy: { usd: 0.5, spentUsd: null, reason: "unknown" }
    })
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
