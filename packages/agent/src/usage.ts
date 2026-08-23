import type { Event } from "@clavia/tardigrade-core/event"
import { turnOf } from "@clavia/tardigrade-code/turns"

// Usage is what one model attempt spent. The normalized fields support projections, while
// providerReports preserve the metrics each provider returned for later normalization and
// repricing (usage.test.ts, "raw provider metrics survive normalization and aggregation").

export type CostSource = "provider" | "table"

// ProviderUsageReport keeps one physical request's provider metrics and serving coordinates.
export interface ProviderUsageReport {
  readonly provider?: string
  readonly model?: string
  readonly providerSpecific: unknown
}

export interface Usage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens?: number
  readonly cachedPromptTokens?: number
  readonly cacheWritePromptTokens?: number
  readonly reasoningTokens?: number
  // costUsd is the compatibility projection: a provider report wins, then a table estimate.
  // The two evidence fields remain independent when both exist (usage.test.ts, "a provider bill
  // and a table estimate coexist").
  readonly costUsd?: number
  readonly costSource?: CostSource
  readonly reportedCostUsd?: number
  readonly estimatedCostUsd?: number
  readonly provider?: string
  readonly model?: string
  readonly providerReports?: ReadonlyArray<ProviderUsageReport>
}

// ModelPricing states the rates used for an independent cost projection.
export interface ModelPricing {
  readonly promptUsdPerToken: number
  readonly completionUsdPerToken: number
  // cachedPromptUsdPerToken and cacheWritePromptUsdPerToken price reported cache buckets. A
  // table that omits a rate cannot estimate a usage stamp with tokens in that bucket
  // (usage.test.ts, "cache buckets require declared rates").
  readonly cachedPromptUsdPerToken?: number
  readonly cacheWritePromptUsdPerToken?: number
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0 }

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined

const numberOf = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

const firstNumber = (rec: Record<string, unknown>, keys: ReadonlyArray<string>): number | undefined => {
  for (const key of keys) {
    const n = numberOf(rec[key])
    if (n !== undefined) return n
  }
  return undefined
}

const nestedNumber = (
  rec: Record<string, unknown>,
  seats: ReadonlyArray<readonly [container: string, keys: ReadonlyArray<string>]>
): number | undefined => {
  for (const [container, keys] of seats) {
    const nested = asRecord(rec[container])
    if (nested === undefined) continue
    const found = firstNumber(nested, keys)
    if (found !== undefined) return found
  }
  return undefined
}

// costNumber reads a provider-billed dollar amount from a usage object. Gateways disagree on
// the field name, so every common seat is checked; a table fill never writes these keys.
export const costNumber = (value: unknown): number | undefined => {
  const rec = asRecord(value)
  if (rec === undefined) return undefined
  const direct = firstNumber(rec, ["cost", "costUsd", "total_cost", "cost_usd"])
  if (direct !== undefined) return direct
  return costNumber(rec.gateway)
}

interface TokenMetrics {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens?: number
  readonly cachedPromptTokens?: number
  readonly cacheWritePromptTokens?: number
  readonly reasoningTokens?: number
  readonly cacheBucketsWereExclusive?: true
}

const tokensOf = (value: unknown): TokenMetrics | undefined => {
  const rec = asRecord(value)
  if (rec === undefined) return undefined
  const prompt = firstNumber(rec, ["promptTokens", "prompt_tokens", "inputTokens", "input_tokens"])
  const completion = firstNumber(rec, ["completionTokens", "completion_tokens", "outputTokens", "output_tokens"])
  if (prompt === undefined && completion === undefined) return undefined
  const total = firstNumber(rec, ["totalTokens", "total_tokens"])
  const exclusiveCached = firstNumber(rec, ["cacheReadInputTokens", "cache_read_input_tokens"])
  const cached =
    exclusiveCached ??
    firstNumber(rec, ["cachedPromptTokens", "cached_prompt_tokens", "cachedTokens", "cached_tokens"]) ??
    nestedNumber(rec, [
      ["promptTokensDetails", ["cachedTokens", "cached_tokens"]],
      ["prompt_tokens_details", ["cachedTokens", "cached_tokens"]],
      ["input_tokens_details", ["cachedTokens", "cached_tokens"]]
    ])
  const exclusiveCacheWrite = firstNumber(rec, [
    "cacheWriteInputTokens",
    "cache_write_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens"
  ])
  const cacheWrite =
    exclusiveCacheWrite ??
    firstNumber(rec, ["cacheWritePromptTokens", "cache_write_prompt_tokens"]) ??
    nestedNumber(rec, [
      ["promptTokensDetails", ["cacheWriteTokens", "cache_write_tokens"]],
      ["prompt_tokens_details", ["cacheWriteTokens", "cache_write_tokens"]],
      ["input_tokens_details", ["cacheWriteTokens", "cache_write_tokens"]]
    ])
  const reasoning =
    firstNumber(rec, ["reasoningTokens", "reasoning_tokens"]) ??
    nestedNumber(rec, [
      ["completionTokensDetails", ["reasoningTokens", "reasoning_tokens"]],
      ["completion_tokens_details", ["reasoningTokens", "reasoning_tokens"]],
      ["output_tokens_details", ["reasoningTokens", "reasoning_tokens"]]
    ])
  const cacheBucketsWereExclusive = exclusiveCached !== undefined || exclusiveCacheWrite !== undefined
  const exclusivePromptTokens = (exclusiveCached ?? 0) + (exclusiveCacheWrite ?? 0)
  const normalizedTotal =
    total === undefined || (total === 0 && (prompt ?? 0) + (completion ?? 0) > 0)
      ? undefined
      : total + exclusivePromptTokens
  return {
    promptTokens: (prompt ?? 0) + exclusivePromptTokens,
    completionTokens: completion ?? 0,
    ...(normalizedTotal === undefined ? {} : { totalTokens: normalizedTotal }),
    ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    ...(cacheWrite === undefined ? {} : { cacheWritePromptTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cacheBucketsWereExclusive ? { cacheBucketsWereExclusive: true as const } : {})
  }
}

export const costOf = (
  pricing: ModelPricing | undefined,
  promptTokens: number,
  completionTokens: number,
  cachedPromptTokens: number = 0,
  cacheWritePromptTokens: number = 0
): number | undefined => {
  if (pricing === undefined) return undefined
  if (cachedPromptTokens > 0 && pricing.cachedPromptUsdPerToken === undefined) return undefined
  if (cacheWritePromptTokens > 0 && pricing.cacheWritePromptUsdPerToken === undefined) return undefined
  const uncachedPromptTokens = promptTokens - cachedPromptTokens - cacheWritePromptTokens
  if (uncachedPromptTokens < 0) return undefined
  return (
    uncachedPromptTokens * pricing.promptUsdPerToken +
    cachedPromptTokens * (pricing.cachedPromptUsdPerToken ?? 0) +
    cacheWritePromptTokens * (pricing.cacheWritePromptUsdPerToken ?? 0) +
    completionTokens * pricing.completionUsdPerToken
  )
}

// priced projects a table independently from the reported bill. costUsd keeps its compatibility
// precedence, including a provider-reported zero (usage.test.ts, "a provider bill and a table
// estimate coexist").
export const priced = (usage: Usage, pricing?: ModelPricing): Usage => {
  const {
    costUsd: previousCostUsd,
    costSource: previousCostSource,
    reportedCostUsd: recordedReportedCostUsd,
    estimatedCostUsd: recordedEstimatedCostUsd,
    ...metrics
  } = usage
  const reportedCostUsd =
    recordedReportedCostUsd ?? (previousCostSource === "provider" ? previousCostUsd : undefined)
  const estimatedCostUsd =
    costOf(
      pricing,
      usage.promptTokens,
      usage.completionTokens,
      usage.cachedPromptTokens,
      usage.cacheWritePromptTokens
    ) ?? recordedEstimatedCostUsd
  const costUsd = previousCostUsd ?? reportedCostUsd ?? estimatedCostUsd
  const previousSource = previousCostSource === "provider" || previousCostSource === "table" ? previousCostSource : undefined
  const costSource =
    previousCostUsd !== undefined
      ? previousSource
      : reportedCostUsd !== undefined
        ? "provider"
        : estimatedCostUsd !== undefined
          ? "table"
          : undefined
  return {
    ...metrics,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(costSource === undefined ? {} : { costSource }),
    ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd })
  }
}

// usageFrom builds spend from one provider reply. The first reported part is retained verbatim;
// later normalized parts refine fields without replacing details that only the wire exposed.
export const usageFrom = (
  reported: unknown,
  pricing?: ModelPricing,
  stamp?: { readonly provider?: string; readonly model?: string },
  providerMetrics?: unknown
): Usage | undefined => {
  const parts = Array.isArray(reported) ? reported : [reported]
  let tokens: TokenMetrics | undefined
  let billed: number | undefined
  let raw: unknown = providerMetrics
  for (const part of parts) {
    if (raw === undefined && part !== undefined && part !== null) raw = part
    const next = tokensOf(part)
    if (next !== undefined) {
      const keepExclusiveFold =
        tokens?.cacheBucketsWereExclusive === true &&
        next.cacheBucketsWereExclusive !== true &&
        next.cachedPromptTokens === undefined &&
        next.cacheWritePromptTokens === undefined
      const totalTokens = keepExclusiveFold ? tokens?.totalTokens : (next.totalTokens ?? tokens?.totalTokens)
      const cachedPromptTokens = next.cachedPromptTokens ?? tokens?.cachedPromptTokens
      const cacheWritePromptTokens = next.cacheWritePromptTokens ?? tokens?.cacheWritePromptTokens
      const reasoningTokens = next.reasoningTokens ?? tokens?.reasoningTokens
      tokens =
        tokens === undefined
          ? next
          : {
              promptTokens: keepExclusiveFold ? tokens.promptTokens : next.promptTokens,
              completionTokens: next.completionTokens,
              ...(totalTokens === undefined ? {} : { totalTokens }),
              ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
              ...(cacheWritePromptTokens === undefined ? {} : { cacheWritePromptTokens }),
              ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
              ...(tokens.cacheBucketsWereExclusive === true || next.cacheBucketsWereExclusive === true
                ? { cacheBucketsWereExclusive: true as const }
                : {})
            }
    }
    const cost = costNumber(part)
    if (cost !== undefined) billed = cost
  }
  if (tokens === undefined && billed === undefined && raw === undefined) return undefined
  const usage: Usage = {
    promptTokens: tokens?.promptTokens ?? 0,
    completionTokens: tokens?.completionTokens ?? 0,
    ...(tokens?.totalTokens === undefined ? {} : { totalTokens: tokens.totalTokens }),
    ...(tokens?.cachedPromptTokens === undefined ? {} : { cachedPromptTokens: tokens.cachedPromptTokens }),
    ...(tokens?.cacheWritePromptTokens === undefined ? {} : { cacheWritePromptTokens: tokens.cacheWritePromptTokens }),
    ...(tokens?.reasoningTokens === undefined ? {} : { reasoningTokens: tokens.reasoningTokens }),
    ...(stamp?.provider === undefined ? {} : { provider: stamp.provider }),
    ...(stamp?.model === undefined ? {} : { model: stamp.model }),
    ...(billed === undefined ? {} : { costUsd: billed, costSource: "provider" as const, reportedCostUsd: billed }),
    ...(raw === undefined
      ? {}
      : {
          providerReports: [
            {
              ...(stamp?.provider === undefined ? {} : { provider: stamp.provider }),
              ...(stamp?.model === undefined ? {} : { model: stamp.model }),
              providerSpecific: raw
            }
          ]
        })
  }
  return tokens === undefined ? usage : priced(usage, pricing)
}

const reportsOf = (value: unknown): ReadonlyArray<ProviderUsageReport> | undefined => {
  if (!Array.isArray(value)) return undefined
  const reports = value.flatMap((candidate): ReadonlyArray<ProviderUsageReport> => {
    const rec = asRecord(candidate)
    if (rec === undefined || !("providerSpecific" in rec)) return []
    const provider = rec.provider
    const model = rec.model
    return [
      {
        ...(typeof provider === "string" && provider !== "" ? { provider } : {}),
        ...(typeof model === "string" && model !== "" ? { model } : {}),
        providerSpecific: rec.providerSpecific
      }
    ]
  })
  return reports.length === 0 ? undefined : reports
}

export const usageOf = (value: unknown): Usage => {
  const carried = asRecord(value)
  const costUsd = numberOf(carried?.costUsd)
  const source = carried?.costSource
  const provider = carried?.provider
  const model = carried?.model
  const reportedCostUsd = numberOf(carried?.reportedCostUsd)
  const estimatedCostUsd = numberOf(carried?.estimatedCostUsd)
  const totalTokens = numberOf(carried?.totalTokens)
  const cachedPromptTokens = numberOf(carried?.cachedPromptTokens)
  const cacheWritePromptTokens = numberOf(carried?.cacheWritePromptTokens)
  const reasoningTokens = numberOf(carried?.reasoningTokens)
  const providerReports = reportsOf(carried?.providerReports)
  return {
    promptTokens: numberOf(carried?.promptTokens) ?? 0,
    completionTokens: numberOf(carried?.completionTokens) ?? 0,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(cacheWritePromptTokens === undefined ? {} : { cacheWritePromptTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(costUsd !== undefined && (source === "provider" || source === "table") ? { costSource: source } : {}),
    ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    ...(typeof provider === "string" && provider !== "" ? { provider } : {}),
    ...(typeof model === "string" && model !== "" ? { model } : {}),
    ...(providerReports === undefined ? {} : { providerReports })
  }
}

const weaker = (a: CostSource | undefined, b: CostSource | undefined): CostSource | undefined => {
  if (a === undefined || b === undefined) return undefined
  return a === "provider" && b === "provider" ? "provider" : "table"
}

const same = (a: string | undefined, b: string | undefined): string | undefined =>
  a !== undefined && a === b ? a : undefined

export const sumUsage = (parts: ReadonlyArray<Usage>): Usage => {
  if (parts.length === 0) return ZERO_USAGE
  let promptTokens = 0
  let completionTokens = 0
  let costUsd = 0
  let known = true
  let source: CostSource | undefined
  let provider: string | undefined
  let model: string | undefined
  const providerReports: ProviderUsageReport[] = []
  let first = true
  for (const part of parts) {
    promptTokens += part.promptTokens
    completionTokens += part.completionTokens
    providerReports.push(...(part.providerReports ?? []))
    if (part.costUsd === undefined) known = false
    else costUsd += part.costUsd
    if (first) {
      source = part.costSource
      provider = part.provider
      model = part.model
      first = false
    } else {
      source = weaker(source, part.costSource)
      provider = same(provider, part.provider)
      model = same(model, part.model)
    }
  }
  const sumKnown = (read: (part: Usage) => number | undefined): number | undefined => {
    let total = 0
    for (const part of parts) {
      const value = read(part)
      if (value === undefined) return undefined
      total += value
    }
    return total
  }
  const totalTokens = sumKnown((part) => part.totalTokens)
  const cachedPromptTokens = sumKnown((part) => part.cachedPromptTokens)
  const cacheWritePromptTokens = sumKnown((part) => part.cacheWritePromptTokens)
  const reasoningTokens = sumKnown((part) => part.reasoningTokens)
  const reportedCostUsd = sumKnown((part) => part.reportedCostUsd)
  const estimatedCostUsd = sumKnown((part) => part.estimatedCostUsd)
  return {
    promptTokens,
    completionTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(cacheWritePromptTokens === undefined ? {} : { cacheWritePromptTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(known ? { costUsd, ...(source === undefined ? {} : { costSource: source }) } : {}),
    ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(providerReports.length === 0 ? {} : { providerReports })
  }
}

const ofTurn = (event: Event, turn: string): boolean => {
  const stamped = turnOf(event)
  if (stamped === turn) return true
  if (stamped !== undefined) return false
  const callId = String(asRecord(event)?.callId ?? "")
  return callId === turn || callId.startsWith(`${turn}/`)
}

// usageIn sums what one turn spent on the model. A live attempt's consequence carries the
// spend as its `usage` field, so the sum reads fields, never event types. An empty usage is an
// attempt with unreported spend, and it keeps the total unknown (usage.test.ts, "unknown is
// sticky"). An event with no usage field is no attempt: a died ModelCalled and the give-up
// TurnFailed invent nothing.
export const usageIn = (log: ReadonlyArray<Event>, turn: string): Usage =>
  sumUsage(
    log.flatMap((event) => {
      if (!ofTurn(event, turn)) return []
      const carried = asRecord(event)?.usage
      return carried === undefined ? [] : [usageOf(carried)]
    })
  )
