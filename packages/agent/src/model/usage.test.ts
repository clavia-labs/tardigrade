import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import fc from "fast-check"
import { initialTurnProjection, reduceTurnProjection, trajectoryFrom } from "@clavia/tardigrade-code/execution/turn-projection"
import { emptyUsageCostFold, foldUsageCost, priced, sumUsage, usageCostOf, usageIn, usageOf, ZERO_USAGE } from "./usage"

const table = { promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 }

describe("priced", () => {
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
    expect(priced({ promptTokens: 1, completionTokens: 1, reportedCostUsd: 0 }, table)).toMatchObject({
      costUsd: 0,
      costSource: "provider",
      reportedCostUsd: 0,
      estimatedCostUsd: 0.003
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
    const first = usageOf({
      inputTokens: { total: 14, cacheRead: 4 },
      outputTokens: { total: 2 },
      provider: "bedrock",
      model: "m",
      providerReports: [{ provider: "bedrock", model: "m", providerSpecific: { inputTokens: 10, cacheReadInputTokens: 4 } }]
    })
    const second = usageOf({
      inputTokens: { total: 17, cacheRead: 5 },
      outputTokens: { total: 3 },
      provider: "bedrock",
      model: "m",
      providerReports: [{ provider: "bedrock", model: "m", providerSpecific: { inputTokens: 12, cacheReadInputTokens: 5 } }]
    })
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


test("unknown token counts survive replay, repricing, and aggregation", () => {
  const partial = { promptTokens: 10 }
  expect(usageOf(JSON.parse(JSON.stringify(partial)))).toEqual(partial)
  expect(priced(partial, { promptUsdPerToken: 1, completionUsdPerToken: 2 }).costUsd).toBeUndefined()
  expect(sumUsage([partial, { promptTokens: 5, completionTokens: 3 }])).toEqual({ promptTokens: 15 })
  expect(sumUsage([{}, { promptTokens: 5, completionTokens: 3 }])).toEqual({})
  expect(sumUsage([ZERO_USAGE, { promptTokens: 5, completionTokens: 3 }])).toEqual({ promptTokens: 5, completionTokens: 3 })
})

test("pricing is derived from the accounting snapshot without changing response usage", () => {
  const usage = { inputTokens: { total: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20 } }
  const log = [
    { type: "ModelCalled", callId: "a", ordinal: 0, turn: "m1", pricing: { promptUsdPerToken: 1, completionUsdPerToken: 2 }, at: 1 },
    { type: "ModelReturned", callId: "a", ordinal: 0, turn: "m1", outcome: "returned", usage, at: 2 }
  ]
  expect(usageIn(log, "m1")).toMatchObject({ estimatedCostUsd: 140 })
  expect(usage).not.toHaveProperty("costUsd")
})


test("usage aggregation excludes failed attempts from totals", () => {
  const success = { type: "ModelReturned", callId: "a", turn: "t", outcome: "returned", usage: { promptTokens: 10, completionTokens: 5, reportedCostUsd: 0.1 }, at: 1 }
  const failed = { type: "ModelReturned", callId: "b", turn: "t", outcome: "failed", usage: {}, at: 2 }
  expect(usageIn([failed], "t")).toMatchObject({ costUsd: 0, reportedCostUsd: 0, estimatedCostUsd: 0 })
  expect(usageIn([success, failed], "t")).toEqual(usageIn([success], "t"))
  const billedFailure = { ...failed, usage: success.usage }
  expect(usageIn([success, billedFailure], "t").reportedCostUsd).toBe(0.1)
})

describe("foldUsageCost", () => {
  // lifetime is infer's recomputed lifetime cost: usageIn over the served trajectory, zero when nothing carries usage.
  const lifetime = (events: ReadonlyArray<Event>) => {
    const usage = usageIn(events)
    const empty = !events.some((event) => event.usage !== undefined || event.legacyUsage !== undefined)
    return { reportedCostUsd: empty ? 0 : usage.reportedCostUsd, estimatedCostUsd: empty ? 0 : usage.estimatedCostUsd }
  }
  const usage = fc.constantFrom<unknown>(
    undefined,
    {},
    { promptTokens: 10, completionTokens: 4 },
    { promptTokens: 7, completionTokens: 3, reportedCostUsd: 0.1 },
    { promptTokens: 3, completionTokens: 1, costUsd: 0.07, costSource: "provider" },
    { inputTokens: { total: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20 } }
  )
  const turn = fc.constantFrom("m0", "m1", "m2")
  const ordinal = fc.integer({ min: 0, max: 2 })
  const event: fc.Arbitrary<Event> = fc.oneof(
    { weight: 1, arbitrary: turn.map((id) => ({ type: "MessageReceived", id, text: "go" })) },
    { weight: 3, arbitrary: fc.record({ turn, ordinal, priced: fc.boolean() }).map(({ turn, ordinal, priced }) => ({ type: "ModelCalled", callId: `${turn}/infer/${ordinal}`, turn, ordinal, ...(priced ? { pricing: table } : {}) })) },
    { weight: 4, arbitrary: fc.record({ turn, ordinal, usage, failed: fc.boolean(), reportedCostUsd: fc.constantFrom(undefined, 0.2) }).map(({ turn, ordinal, usage, failed, reportedCostUsd }) => ({ type: "ModelReturned", callId: `${turn}/infer/${ordinal}`, turn, ordinal, outcome: failed ? "failed" : "returned", ...(usage === undefined ? {} : { usage }), ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }) })) },
    { weight: 2, arbitrary: fc.record({ turn, usage }).map(({ turn, usage }) => ({ type: "ToolCalled", callId: `${turn}/c`, name: "execute", arguments: {}, turn, ...(usage === undefined ? {} : { legacyUsage: usage }) })) },
    { weight: 1, arbitrary: fc.record({ turn, type: fc.constantFrom("TurnCompleted", "TurnFailed", "TurnCancelled"), usage: fc.constantFrom(undefined, { promptTokens: 1, completionTokens: 1 }) }).map(({ turn, type, usage }) => ({ type, turn, ...(usage === undefined ? {} : { usage }) })) },
    { weight: 1, arbitrary: turn.map((turn) => ({ type: "TurnResumed", turn, failedEpoch: 0, epoch: 1 })) }
  )

  test("matches usageIn over the served trajectory at every prefix it does not mark stale", () => {
    let compared = 0
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (log) => {
        let turns = initialTurnProjection()
        let fold = emptyUsageCostFold
        for (const next of log) {
          turns = reduceTurnProjection(turns, next)
          fold = foldUsageCost(fold, next)
          if (fold.stale) continue
          compared += 1
          expect(usageCostOf(fold)).toEqual(lifetime(trajectoryFrom(turns)))
        }
      }),
      { numRuns: 500 }
    )
    expect(compared).toBeGreaterThan(1_000)
  })

  test("stays current through served turns and goes stale when a late ModelCalled prices an earlier response", () => {
    const served: Event[] = [
      { type: "MessageReceived", id: "m1", text: "go" },
      { type: "ModelCalled", callId: "m1/infer/0", turn: "m1", ordinal: 0, pricing: table },
      { type: "ModelReturned", callId: "m1/infer/0", turn: "m1", ordinal: 0, outcome: "returned", usage: { promptTokens: 10, completionTokens: 4 } },
      { type: "TurnCompleted", output: "ok", turn: "m1" },
      { type: "ModelReturned", callId: "m2/infer/0", turn: "m2", ordinal: 0, outcome: "returned", usage: { promptTokens: 1, completionTokens: 1 } }
    ]
    const fold = served.reduce(foldUsageCost, emptyUsageCostFold)
    expect(fold.stale).toBe(false)
    expect(usageCostOf(fold)).toEqual(lifetime(served))
    const late = foldUsageCost(fold, { type: "ModelCalled", callId: "m2/infer/0", turn: "m2", ordinal: 0, pricing: table })
    expect(late.stale).toBe(true)
  })

  test.each(["head usage", "late pricing"])("a fold made stale by %s stops retaining and pricing later events", (reason) => {
    const initial: Event[] = reason === "head usage"
      ? [{ type: "MessageReceived", id: "m1", usage: {} }]
      : [
        { type: "ModelReturned", turn: "m1", ordinal: 0, usage: { promptTokens: 10, completionTokens: 4 } },
        { type: "ModelCalled", turn: "m1", ordinal: 0, pricing: table }
      ]
    const stale = initial.reduce(foldUsageCost, emptyUsageCostFold)
    expect(stale.stale).toBe(true)
    const later: Event[] = [
      { type: "ModelCalled", turn: "m2", ordinal: 0, pricing: table },
      { type: "ModelReturned", turn: "m2", ordinal: 0, usage: { promptTokens: 10, completionTokens: 4 } },
      { type: "ModelReturned", turn: "m2", ordinal: 1, outcome: "failed" },
      { type: "ToolCalled", turn: "m2", legacyUsage: { reportedCostUsd: 0.1 } }
    ]
    for (const next of later) expect(foldUsageCost(stale, next)).toBe(stale)
  })
})
