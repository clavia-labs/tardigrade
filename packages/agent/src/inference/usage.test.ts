import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { costNumber, priced, sumUsage, usageFrom, usageIn, usageOf, ZERO_USAGE } from "./usage"

const table = { promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 }

describe("priced and usageFrom", () => {
  test("a provider bill and a table estimate coexist", () => {
    const raw = {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 },
      cost: 0
    }
    const billed = usageFrom(
      raw,
      { ...table, cachedPromptUsdPerToken: 0.0001 },
      {
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-sonnet-4.6"
      }
    )
    expect(billed).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      cachedPromptTokens: 4,
      reasoningTokens: 2,
      costUsd: 0,
      costSource: "provider",
      reportedCostUsd: 0,
      estimatedCostUsd: 6 * 0.001 + 4 * 0.0001 + 4 * 0.002,
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4.6",
      providerReports: [
        { provider: "vercel-ai-gateway", model: "anthropic/claude-sonnet-4.6", providerSpecific: raw }
      ]
    })

    const filledRaw = { prompt_tokens: 10, completion_tokens: 4 }
    const filled = usageFrom(filledRaw, table, { provider: "openai", model: "test" })
    expect(filled).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      costUsd: 10 * 0.001 + 4 * 0.002,
      costSource: "table",
      estimatedCostUsd: 10 * 0.001 + 4 * 0.002,
      provider: "openai",
      model: "test",
      providerReports: [{ provider: "openai", model: "test", providerSpecific: filledRaw }]
    })
    const unknownRaw = { promptTokens: 10, completionTokens: 4 }
    const unknown = usageFrom(unknownRaw)
    expect(unknown).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      providerReports: [{ providerSpecific: unknownRaw }]
    })
    const futureRaw = { future_billable_units: 3 }
    expect(usageFrom(futureRaw, table, { provider: "future", model: "m" })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      provider: "future",
      model: "m",
      providerReports: [{ provider: "future", model: "m", providerSpecific: futureRaw }]
    })
    expect(usageFrom(undefined)).toBeUndefined()
  })

  test("priced retains a provider figure and recomputes the table projection", () => {
    const reported = { promptTokens: 1, completionTokens: 1, costUsd: 9, costSource: "provider" as const }
    expect(priced(reported, table)).toEqual({
      ...reported,
      reportedCostUsd: 9,
      estimatedCostUsd: 0.003
    })
    expect(priced({ promptTokens: 10, completionTokens: 4 }, table)).toMatchObject({
      costUsd: 10 * 0.001 + 4 * 0.002,
      costSource: "table",
      estimatedCostUsd: 10 * 0.001 + 4 * 0.002
    })
    expect(priced({ promptTokens: 1, completionTokens: 1, costUsd: 9 }, table)).toEqual({
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 9,
      estimatedCostUsd: 0.003
    })
    expect(
      priced({ promptTokens: 1, completionTokens: 1, costUsd: 9, estimatedCostUsd: 8 }, table)
    ).toEqual({
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 9,
      estimatedCostUsd: 0.003
    })
    const recordedTable = {
      promptTokens: 10,
      completionTokens: 4,
      cachedPromptTokens: 5,
      costUsd: 0.7,
      costSource: "table" as const
    }
    expect(priced(recordedTable, table)).toEqual(recordedTable)
  })

  test("cache buckets require declared rates", () => {
    const usage = { promptTokens: 10, completionTokens: 4, cachedPromptTokens: 5 }
    expect(priced(usage, table)).toEqual(usage)
    expect(
      priced(usage, { ...table, cachedPromptUsdPerToken: 0.0002 })
    ).toMatchObject({ estimatedCostUsd: 5 * 0.001 + 5 * 0.0002 + 4 * 0.002 })
    expect(
      priced(
        { promptTokens: 10, completionTokens: 4, cachedPromptTokens: 4, cacheWritePromptTokens: 2 },
        { ...table, cachedPromptUsdPerToken: 0.0002, cacheWritePromptUsdPerToken: 0.00125 }
      )
    ).toMatchObject({ estimatedCostUsd: 4 * 0.001 + 4 * 0.0002 + 2 * 0.00125 + 4 * 0.002 })
  })

  test("a normalized adapter view fills details the raw report omits", () => {
    const raw = { prompt_tokens: 10, completion_tokens: 4, cost: 0 }
    expect(
      usageFrom(
        [
          raw,
          {
            promptTokens: 10,
            completionTokens: 4,
            totalTokens: 15,
            promptTokensDetails: { cachedTokens: 4, cacheWriteTokens: 2 },
            completionTokensDetails: { reasoningTokens: 2 }
          }
        ],
        { ...table, cachedPromptUsdPerToken: 0.0002, cacheWritePromptUsdPerToken: 0.00125 }
      )
    ).toMatchObject({
      totalTokens: 15,
      cachedPromptTokens: 4,
      cacheWritePromptTokens: 2,
      reasoningTokens: 2,
      reportedCostUsd: 0,
      providerReports: [{ providerSpecific: raw }]
    })

    const converse = { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadInputTokens: 4 }
    expect(
      usageFrom(
        [converse, { promptTokens: 10, completionTokens: 2, totalTokens: 12 }],
        { ...table, cachedPromptUsdPerToken: 0.0002 },
        { provider: "bedrock", model: "m" },
        converse
      )
    ).toMatchObject({
      promptTokens: 14,
      completionTokens: 2,
      totalTokens: 16,
      cachedPromptTokens: 4,
      estimatedCostUsd: 10 * 0.001 + 4 * 0.0002 + 2 * 0.002
    })
    expect(usageFrom({ promptTokens: 3, completionTokens: 2, totalTokens: 0 })).not.toHaveProperty("totalTokens")
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
    const billed = {
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0.25,
      costSource: "provider" as const,
      reportedCostUsd: 0.25,
      estimatedCostUsd: 0.4,
      provider: "a",
      model: "m"
    }
    const filled = {
      promptTokens: 2,
      completionTokens: 2,
      costUsd: 0.5,
      costSource: "table" as const,
      estimatedCostUsd: 0.5,
      provider: "a",
      model: "m"
    }
    const mixed = sumUsage([billed, filled])
    expect(mixed).toEqual({
      promptTokens: 3,
      completionTokens: 3,
      costUsd: 0.75,
      costSource: "table",
      estimatedCostUsd: 0.9,
      provider: "a",
      model: "m"
    })
    expect(sumUsage([billed, { promptTokens: 1, completionTokens: 0 }]).costUsd).toBeUndefined()
    expect(sumUsage([billed, { ...billed, provider: "b" }]).provider).toBeUndefined()
    expect(sumUsage([])).toEqual(ZERO_USAGE)
  })

  test("raw provider metrics survive normalization and aggregation", () => {
    const first = usageFrom(
      { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadInputTokens: 4 },
      undefined,
      { provider: "bedrock", model: "m" }
    )!
    const second = usageFrom(
      { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadInputTokens: 5 },
      undefined,
      { provider: "bedrock", model: "m" }
    )!
    expect(
      priced(first, { ...table, cachedPromptUsdPerToken: 0.0002 })
    ).toMatchObject({ estimatedCostUsd: 10 * 0.001 + 4 * 0.0002 + 2 * 0.002 })
    const summed = sumUsage([first, second])
    expect(summed).toMatchObject({
      promptTokens: 31,
      completionTokens: 5,
      totalTokens: 36,
      cachedPromptTokens: 9,
      providerReports: [
        { provider: "bedrock", model: "m", providerSpecific: first.providerReports![0]!.providerSpecific },
        { provider: "bedrock", model: "m", providerSpecific: second.providerReports![0]!.providerSpecific }
      ]
    })
    expect(usageOf(JSON.parse(JSON.stringify(summed)))).toEqual(summed)
  })
})

describe("usageIn", () => {
  test("a turn sums the consequences' usage, and a died attempt invents nothing", () => {
    const log: Event[] = [
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      { type: "ModelCalled", callId: "m1/infer/0", ordinal: 0, turn: "m1", at: 1 },
      {
        type: "ToolCalled",
        callId: "c1",
        name: "execute",
        arguments: {},
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

  test("an empty usage poisons the total, a usage-less terminal invents nothing, and an unstamped consequence still belongs by callId", () => {
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
      { type: "ToolCalled", callId: "c1", name: "execute", arguments: {}, usage: {}, turn: "m1", at: 1 },
      { type: "TurnCompleted", output: "ok", usage: billed, turn: "m1", at: 2 },
      { type: "TurnFailed", error: "gave up", turn: "m1", at: 3 }
    ]
    expect(usageIn(log, "m1")).toEqual({ promptTokens: 10, completionTokens: 4 })
    expect(
      usageIn(
        [{ type: "ToolCalled", callId: "m1/infer/0", name: "execute", arguments: {}, usage: billed, at: 1 }],
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
    expect(
      sumUsage([usageOf({ promptTokens: 3, completionTokens: 1, costUsd: 0.4, costSource: "table" })])
        .estimatedCostUsd
    ).toBeUndefined()
  })
})
