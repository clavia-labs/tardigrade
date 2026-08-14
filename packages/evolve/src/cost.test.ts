import { describe, expect, test } from "bun:test"
import type { Event } from "@flamecast/core"
import { costed, evolutionCostOf, sumEvolutionCosts, zeroEvolutionCost } from "./cost"

const first: ReadonlyArray<Event> = [
  {
    type: "ModelReturned",
    usage: { promptTokens: 100, completionTokens: 20, costUsd: 0.003 }
  },
  { type: "ToolCalled", name: "lookup_invoice" },
  { type: "ToolCalled", name: "answer" }
]

const second: ReadonlyArray<Event> = [
  {
    type: "ModelReturned",
    usage: { promptTokens: 50, completionTokens: 10, costUsd: 0.002 }
  },
  { type: "ToolCalled", name: "fetch_ledger" },
  { type: "ToolCalled", name: "request-budget" }
]

describe("evolution cost", () => {
  test("projects model usage and work-tool calls from harness logs", () => {
    expect(evolutionCostOf(first, second)).toEqual({
      promptTokens: 150,
      completionTokens: 30,
      costUsd: 0.005,
      toolCalls: 2
    })
  })

  test("attaches projected cost to a callback value", () => {
    expect(costed("candidate", first)).toEqual({
      value: "candidate",
      cost: {
        promptTokens: 100,
        completionTokens: 20,
        costUsd: 0.003,
        toolCalls: 1
      }
    })
    expect(costed(undefined).cost).toEqual(zeroEvolutionCost())
  })

  test("rejects invalid reported cost", () => {
    expect(() =>
      sumEvolutionCosts([
        { promptTokens: -1, completionTokens: 0, costUsd: 0, toolCalls: 0 }
      ])
    ).toThrow("evolution cost promptTokens must be a non-negative finite number")
  })

  test("rejects an overflowing total", () => {
    expect(() =>
      sumEvolutionCosts([
        {
          promptTokens: Number.MAX_VALUE,
          completionTokens: 0,
          costUsd: 0,
          toolCalls: 0
        },
        {
          promptTokens: Number.MAX_VALUE,
          completionTokens: 0,
          costUsd: 0,
          toolCalls: 0
        }
      ])
    ).toThrow("evolution cost promptTokens must be a non-negative finite number")
  })
})
