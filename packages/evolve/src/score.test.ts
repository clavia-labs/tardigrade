import { describe, expect, test } from "bun:test"
import type { Event } from "@flamecast/core"
import { scoreOf, spendOf, verdictsOf } from "./score"

const log: ReadonlyArray<Event> = [
  { type: "MessageReceived", id: "m-1", text: "What does order 4182 owe?", at: 1 },
  { type: "ModelCalled", turn: "m-1", callId: "m-1/infer/0", at: 2 },
  {
    type: "ModelReturned",
    turn: "m-1",
    callId: "m-1/infer/0",
    usage: { promptTokens: 1200, completionTokens: 80, costUsd: 0.004 },
    at: 3
  },
  { type: "TurnCompleted", turn: "m-1", output: "312.00", at: 4 },
  {
    type: "RewardGranted",
    run: "r-1",
    score: 0.6,
    reason: "called lookup_invoice four times with the same order id",
    at: 5
  },
  { type: "RewardGranted", run: "r-1", regime: "cost", score: 0.2, at: 6 }
]

describe("projections over a stored log", () => {
  test("read the verdicts a proposer reflects on", () => {
    expect(verdictsOf(log)).toEqual([
      { score: 0.6, reason: "called lookup_invoice four times with the same order id" },
      { score: 0.2, reason: "" }
    ])
  })

  test("sum the score", () => {
    expect(scoreOf(log)).toBeCloseTo(0.8, 10)
    expect(scoreOf([])).toBe(0)
  })

  test("sum the spend", () => {
    expect(spendOf(log)).toEqual({ promptTokens: 1200, completionTokens: 80, costUsd: 0.004 })
    // A binding that reported nothing costs zero rather than NaN, so a sum always lands.
    expect(spendOf([{ type: "ModelReturned", turn: "m-1", at: 7 }])).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0
    })
  })
})
