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

  test("gateway prompt totals already include cache creation", () => {
    const raw = {
      prompt_tokens: 137973,
      completion_tokens: 188,
      total_tokens: 138161,
      cache_creation_input_tokens: 137970,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 118 },
      cost: 0,
      market_cost: 0.8670275
    }
    const pricing = {
      promptUsdPerToken: 10 / 1_000_000,
      completionUsdPerToken: 50 / 1_000_000,
      cachedPromptUsdPerToken: 1 / 1_000_000,
      cacheWritePromptUsdPerToken: 12.5 / 1_000_000
    }
    const expected = {
      promptTokens: 137973,
      completionTokens: 188,
      totalTokens: 138161,
      cachedPromptTokens: 0,
      cacheWritePromptTokens: 137970,
      reasoningTokens: 118,
      reportedCostUsd: 0,
      costUsd: 0,
      costSource: "provider" as const,
      estimatedCostUsd: 3 * pricing.promptUsdPerToken + 137970 * pricing.cacheWritePromptUsdPerToken + 188 * pricing.completionUsdPerToken,
      providerReports: [{ providerSpecific: raw }]
    }
    expect(usageFrom(raw, pricing)).toEqual(expected)
    expect(
      usageFrom([raw, { promptTokens: 137973, completionTokens: 188, totalTokens: 138161 }], pricing)
    ).toEqual(expected)
    const stamp = { provider: "vercel-ai-gateway", model: "openai/gpt-6-astra" }
    const providerMetrics = { usage: raw, provider_metadata: undefined }
    expect(usageFrom([raw, undefined], pricing, stamp, providerMetrics)).toEqual({
      ...expected,
      ...stamp,
      providerReports: [{ ...stamp, providerSpecific: providerMetrics }]
    })
  })

  test("prompt totals include cache reads and writes across field aliases", () => {
    for (const prompt of [{ promptTokens: 10 }, { prompt_tokens: 10 }]) {
      for (const cache of [
        { cacheReadInputTokens: 4, cacheWriteInputTokens: 2 },
        { cache_read_input_tokens: 4, cache_write_input_tokens: 2 },
        { cacheReadInputTokens: 4, cacheCreationInputTokens: 2 },
        { cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }
      ]) {
        expect(usageFrom({ ...prompt, ...cache, completionTokens: 3, totalTokens: 13 })).toMatchObject({
          promptTokens: 10,
          completionTokens: 3,
          totalTokens: 13,
          cachedPromptTokens: 4,
          cacheWritePromptTokens: 2
        })
      }
    }
  })

  test("Anthropic and Converse input counts exclude cache reads and writes", () => {
    for (const raw of [
      { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
      { inputTokens: 4, outputTokens: 3, totalTokens: 7, cacheReadInputTokens: 4, cacheWriteInputTokens: 2 }
    ]) {
      const pricing = { ...table, cachedPromptUsdPerToken: 0.0002, cacheWritePromptUsdPerToken: 0.00125 }
      const expected = {
        promptTokens: 10,
        completionTokens: 3,
        cachedPromptTokens: 4,
        cacheWritePromptTokens: 2,
        estimatedCostUsd: 4 * 0.001 + 4 * 0.0002 + 2 * 0.00125 + 3 * 0.002
      }
      expect(usageFrom(raw, pricing)).toMatchObject(expected)
      expect(
        usageFrom([raw, { promptTokens: 4, completionTokens: 3, totalTokens: 7 }], pricing)
      ).toMatchObject(expected)
    }
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
