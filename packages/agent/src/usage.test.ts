import { describe, expect, test } from "bun:test"
import type { Event } from "@tardigrade/core/event"
import { costNumber, priced, sumUsage, usageFrom, usageIn, usageOf, ZERO_USAGE } from "./usage"

const table = { promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 }

describe("priced and usageFrom", () => {
  test("a reported cost keeps its source, including zero, and a price table fills an omitted cost", () => {
    const billed = usageFrom({ promptTokens: 10, completionTokens: 4, cost: 0 }, table, {
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4.6"
    })
    expect(billed).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      costUsd: 0,
      costSource: "provider",
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4.6"
    })
    const filled = usageFrom({ prompt_tokens: 10, completion_tokens: 4 }, table, { provider: "openai", model: "test" })
    expect(filled).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      costUsd: 10 * 0.001 + 4 * 0.002,
      costSource: "table",
      provider: "openai",
      model: "test"
    })
    const unknown = usageFrom({ promptTokens: 10, completionTokens: 4 })
    expect(unknown).toEqual({ promptTokens: 10, completionTokens: 4 })
    expect(usageFrom(undefined)).toBeUndefined()
  })

  test("priced does not relabel a figure that already has a cost", () => {
    const reported = { promptTokens: 1, completionTokens: 1, costUsd: 9, costSource: "provider" as const }
    expect(priced(reported, table)).toEqual(reported)
    expect(priced({ promptTokens: 10, completionTokens: 4 }, table).costSource).toBe("table")
  })

  test("costNumber reads the seats a gateway actually writes", () => {
    expect(costNumber({ cost: 0.01 })).toBe(0.01)
    expect(costNumber({ costUsd: "0.2" })).toBe(0.2)
    expect(costNumber({ gateway: { cost: 0 } })).toBe(0)
    expect(costNumber({ prompt_tokens: 3 })).toBeUndefined()
  })
})

describe("sumUsage", () => {
  test("unknown is sticky, and mixed sources take the weaker label", () => {
    const billed = { promptTokens: 1, completionTokens: 1, costUsd: 0.25, costSource: "provider" as const, provider: "a", model: "m" }
    const filled = { promptTokens: 2, completionTokens: 2, costUsd: 0.5, costSource: "table" as const, provider: "a", model: "m" }
    const mixed = sumUsage([billed, filled])
    expect(mixed).toEqual({
      promptTokens: 3,
      completionTokens: 3,
      costUsd: 0.75,
      costSource: "table",
      provider: "a",
      model: "m"
    })
    expect(sumUsage([billed, { promptTokens: 1, completionTokens: 0 }]).costUsd).toBeUndefined()
    expect(sumUsage([billed, { ...billed, provider: "b" }]).provider).toBeUndefined()
    expect(sumUsage([])).toEqual(ZERO_USAGE)
  })
})

describe("usageIn", () => {
  test("a turn sums ModelReturned, and a died attempt invents nothing", () => {
    const log: Event[] = [
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      { type: "ModelCalled", callId: "m1/infer/0", ordinal: 0, turn: "m1", at: 1 },
      {
        type: "ModelReturned",
        callId: "m1/infer/0",
        ordinal: 0,
        turn: "m1",
        usage: {
          promptTokens: 10,
          completionTokens: 4,
          costUsd: 0.01,
          costSource: "provider",
          provider: "openai",
          model: "m"
        },
        at: 2
      },
      { type: "ModelCalled", callId: "m1/infer/1", ordinal: 1, turn: "m1", at: 3 },
      { type: "TurnCompleted", output: "ok", turn: "m1", at: 4 }
    ]
    expect(usageIn(log, "m1")).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      costUsd: 0.01,
      costSource: "provider",
      provider: "openai",
      model: "m"
    })
    expect(usageIn(log, "m2")).toEqual(ZERO_USAGE)
  })

  test("a return with no usage poisons the total, and an unstamped return still belongs by callId", () => {
    const billed = {
      promptTokens: 10,
      completionTokens: 4,
      costUsd: 0.01,
      costSource: "provider" as const,
      provider: "openai",
      model: "m"
    }
    const log: Event[] = [
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      { type: "ModelReturned", callId: "m1/infer/0", ordinal: 0, turn: "m1", at: 1 },
      { type: "ModelReturned", callId: "m1/infer/1", ordinal: 1, turn: "m1", usage: billed, at: 2 }
    ]
    expect(usageIn(log, "m1")).toEqual({ promptTokens: 10, completionTokens: 4 })
    expect(
      usageIn(
        [{ type: "ModelReturned", callId: "m1/infer/0", ordinal: 0, usage: billed, at: 1 }],
        "m1"
      )
    ).toEqual(billed)
  })

  test("usageOf keeps a labeled figure and drops a source with no cost", () => {
    expect(usageOf({ promptTokens: 3, completionTokens: 1, costUsd: 0, costSource: "provider" })).toEqual({
      promptTokens: 3,
      completionTokens: 1,
      costUsd: 0,
      costSource: "provider"
    })
    expect(usageOf({ promptTokens: 1, completionTokens: 0, costSource: "table" }).costSource).toBeUndefined()
  })
})
