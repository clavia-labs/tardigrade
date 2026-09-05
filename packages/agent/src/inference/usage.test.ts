import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { priced, sumUsage, usageFrom, usageIn, usageOf, ZERO_USAGE } from "./usage"

const table = { promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 }
const counts = { promptTokens: 10, completionTokens: 4, cachedPromptTokens: 0, cacheWritePromptTokens: 0 }

describe("usageFrom", () => {
  test("raw reports stay uninterpreted by default", () => {
    for (const raw of [
      { prompt_tokens: 137973, completion_tokens: 188, cache_creation_input_tokens: 137970, cost: 0 },
      { input_tokens: 3, cache_creation_input_tokens: 137970, output_tokens: 188 },
      { inputTokens: 3, cacheWriteInputTokens: 137970, outputTokens: 188 },
      { promptTokens: 10, completionTokens: 4, costUsd: 1 },
      { future_billable_units: 3 },
      {},
      null
    ]) {
      const report = { provider: "p", model: "m", providerSpecific: raw }
      expect(usageFrom(report)).toEqual({ provider: "p", model: "m", providerReports: [report] })
    }
  })

  test("the caller selects the usage interpretation", () => {
    const raw = { input: 10, output: 4, cache: 6, paid: 0 }
    const report = { provider: "p", model: "m", providerSpecific: raw }
    const inclusive = usageFrom(report, (received) => {
      expect(received).toBe(report)
      return { promptTokens: raw.input, completionTokens: raw.output, cachedPromptTokens: raw.cache, reportedCostUsd: raw.paid }
    })
    const exclusive = usageFrom(report, () => ({ promptTokens: raw.input + raw.cache }))
    expect(inclusive).toEqual({
      provider: "p", model: "m", promptTokens: 10, completionTokens: 4,
      cachedPromptTokens: 6, reportedCostUsd: 0, providerReports: [report]
    })
    expect(exclusive.promptTokens).toBe(16)
    expect(usageFrom(report, () => undefined)).toEqual(usageFrom(report))
    expect(raw).toEqual({ input: 10, output: 4, cache: 6, paid: 0 })
  })

  test("multiple observations reach the caller without merging or summing", () => {
    const observations = [{ input_tokens: 10 }, { output_tokens: 4 }, { output_tokens: 8 }]
    const report = { providerSpecific: observations }
    expect(usageFrom(report, (received) => {
      expect(received.providerSpecific).toBe(observations)
      return { promptTokens: 10, completionTokens: 8 }
    })).toEqual({ promptTokens: 10, completionTokens: 8, providerReports: [report] })
  })

  test("normalized metrics reject coercion and invalid numbers", () => {
    for (const value of ["10", null, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => usageOf({ promptTokens: value })).toThrow("usage.promptTokens")
    }
    expect(() => usageFrom({ providerSpecific: {} }, () => ({ completionTokens: NaN }))).toThrow("usage.completionTokens")
    expect(() => usageOf({ costUsd: "0.2" })).toThrow("usage.costUsd")
    expect(() => usageOf("invalid")).toThrow("usage must be an object")
    expect(() => usageOf({ costUsd: 1, costSource: "guessed" })).toThrow("usage.costSource")
    expect(usageOf({})).toEqual({})
    expect(usageOf({ promptTokens: 0 })).toEqual({ promptTokens: 0 })
    expect(() => usageFrom({} as never)).toThrow("ProviderUsageReport")
  })
})

describe("priced", () => {
  test("a provider bill and a table estimate coexist", () => {
    expect(priced({ ...counts, costUsd: 0, costSource: "provider" }, table)).toEqual({
      ...counts, costUsd: 0, costSource: "provider", reportedCostUsd: 0, estimatedCostUsd: (10 * 0.001 + 4 * 0.002)
    })
    expect(priced(counts, table)).toEqual({ ...counts, costUsd: (10 * 0.001 + 4 * 0.002), costSource: "table", estimatedCostUsd: (10 * 0.001 + 4 * 0.002) })
    expect(priced({ ...counts, reportedCostUsd: 2 }, table)).toMatchObject({ costUsd: 2, costSource: "provider", estimatedCostUsd: (10 * 0.001 + 4 * 0.002) })
  })

  test("pricing requires explicit cache counts", () => {
    for (const usage of [
      {},
      { promptTokens: 10, completionTokens: 4 },
      { promptTokens: 10, completionTokens: 4, cachedPromptTokens: 0 },
      { promptTokens: 10, completionTokens: 4, cacheWritePromptTokens: 0 }
    ]) expect(priced(usage, table)).toEqual(usage)
    const raw = usageFrom({ providerSpecific: { prompt_tokens: 10, completion_tokens: 4, cost: 0 } })
    expect(priced(raw, table)).toEqual(raw)
  })

  test("cache buckets require declared rates", () => {
    const usage = { ...counts, cachedPromptTokens: 4, cacheWritePromptTokens: 2 }
    expect(priced(usage, table)).toEqual(usage)
    expect(priced(usage, { ...table, cachedPromptUsdPerToken: 0.0002 })).toEqual(usage)
    expect(priced(usage, { ...table, cachedPromptUsdPerToken: 0.0002, cacheWritePromptUsdPerToken: 0.00125 }))
      .toMatchObject({ estimatedCostUsd: 4 * 0.001 + 4 * 0.0002 + 2 * 0.00125 + 4 * 0.002 })
    const inconsistent = { ...counts, cachedPromptTokens: 11 }
    expect(priced(inconsistent, { ...table, cachedPromptUsdPerToken: 0.0002 })).toEqual(inconsistent)
    expect(priced(counts, { ...table, promptUsdPerToken: NaN })).toEqual(counts)
  })

  test("a recorded estimate survives an incomplete table and a complete table recomputes it", () => {
    const usage = { ...counts, cachedPromptTokens: 4, estimatedCostUsd: 9 }
    expect(priced(usage, table)).toMatchObject({ estimatedCostUsd: 9 })
    expect(priced(usage, { ...table, cachedPromptUsdPerToken: 0.0002 }))
      .toMatchObject({ estimatedCostUsd: 6 * 0.001 + 4 * 0.0002 + 4 * 0.002 })
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

  test("raw reports survive aggregation and unknown metrics stay unknown", () => {
    const raw = usageFrom({ provider: "p", model: "m", providerSpecific: { future_units: 3 } })
    const measured = { promptTokens: 10, completionTokens: 2, costUsd: 1 }
    expect(sumUsage([measured, raw])).toEqual({ providerReports: raw.providerReports! })
    expect(sumUsage([measured, { completionTokens: 3 }])).toEqual({ completionTokens: 5 })
    const summed = sumUsage([raw, raw])
    expect(summed.providerReports).toHaveLength(2)
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
    expect(usageIn(log, "m1")).toEqual({})
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
