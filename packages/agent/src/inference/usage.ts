import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnOf } from "@clavia/tardigrade-code/execution/turns"

export type CostSource = "provider" | "table"

// ProviderUsageReport keeps one physical request's provider metrics and serving coordinates.
export interface ProviderUsageReport {
  readonly provider?: string
  readonly model?: string
  readonly providerSpecific: unknown
}

// Usage carries raw reports and optional interpreted metrics; an omitted metric is unknown (usage.test.ts, "raw reports stay uninterpreted by default").
export interface Usage {
  readonly promptTokens?: number
  readonly completionTokens?: number
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

// ZERO_USAGE represents an empty set of attempts (usage.test.ts, "unknown is sticky, and mixed sources take the weaker label").
export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0 }

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined

// UsageAdapter interprets one physical request under a caller-defined provider contract.
export type UsageAdapter = (report: ProviderUsageReport) => Omit<Usage, "provider" | "model" | "providerReports"> | undefined

const numberOf = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (field.endsWith("Tokens") && !Number.isSafeInteger(value))) {
    throw new TypeError(`usage.${field} must be a non-negative ${field.endsWith("Tokens") ? "safe integer" : "finite number"}`)
  }
  return value
}

// costOf prices explicit token buckets and returns undefined when a count or required rate is unknown (usage.test.ts, "pricing requires explicit cache counts").
export const costOf = (
  pricing: ModelPricing | undefined,
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  cachedPromptTokens: number | undefined,
  cacheWritePromptTokens: number | undefined
): number | undefined => {
  if (pricing === undefined || promptTokens === undefined || completionTokens === undefined || cachedPromptTokens === undefined || cacheWritePromptTokens === undefined) return undefined
  for (const count of [promptTokens, completionTokens, cachedPromptTokens, cacheWritePromptTokens]) {
    if (!Number.isSafeInteger(count) || count < 0) return undefined
  }
  for (const rate of [pricing.promptUsdPerToken, pricing.completionUsdPerToken, pricing.cachedPromptUsdPerToken ?? 0, pricing.cacheWritePromptUsdPerToken ?? 0]) {
    if (!Number.isFinite(rate) || rate < 0) return undefined
  }
  if (cachedPromptTokens > 0 && pricing.cachedPromptUsdPerToken === undefined) return undefined
  if (cacheWritePromptTokens > 0 && pricing.cacheWritePromptUsdPerToken === undefined) return undefined
  const uncachedPromptTokens = promptTokens - cachedPromptTokens - cacheWritePromptTokens
  if (uncachedPromptTokens < 0) return undefined
  const estimate = (
    uncachedPromptTokens * pricing.promptUsdPerToken +
    cachedPromptTokens * (pricing.cachedPromptUsdPerToken ?? 0) +
    cacheWritePromptTokens * (pricing.cacheWritePromptUsdPerToken ?? 0) +
    completionTokens * pricing.completionUsdPerToken
  )
  return Number.isFinite(estimate) ? estimate : undefined
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

// usageFrom preserves a raw report and applies an adapter only when the caller supplies one (usage.test.ts, "raw reports stay uninterpreted by default").
export const usageFrom = (report: ProviderUsageReport, adapter?: UsageAdapter): Usage => {
  if (asRecord(report) === undefined || !("providerSpecific" in report)) {
    throw new TypeError("usageFrom requires a ProviderUsageReport with providerSpecific")
  }
  const { provider: _provider, model: _model, providerReports: _reports, ...metrics } = usageOf(adapter?.(report))
  return {
    ...metrics,
    ...(report.provider === undefined ? {} : { provider: report.provider }),
    ...(report.model === undefined ? {} : { model: report.model }),
    providerReports: [report]
  }
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

// usageOf reads the declared Usage schema without aliases or numeric coercion (usage.test.ts, "normalized metrics reject coercion and invalid numbers").
export const usageOf = (value: unknown): Usage => {
  const carried = asRecord(value)
  if (value !== undefined && (carried === undefined || Array.isArray(value))) {
    throw new TypeError("usage must be an object")
  }
  const costUsd = numberOf(carried?.costUsd, "costUsd")
  const source = carried?.costSource
  if (source !== undefined && source !== "provider" && source !== "table") {
    throw new TypeError("usage.costSource must be provider or table")
  }
  const provider = carried?.provider
  const model = carried?.model
  const reportedCostUsd = numberOf(carried?.reportedCostUsd, "reportedCostUsd")
  const estimatedCostUsd = numberOf(carried?.estimatedCostUsd, "estimatedCostUsd")
  const promptTokens = numberOf(carried?.promptTokens, "promptTokens")
  const completionTokens = numberOf(carried?.completionTokens, "completionTokens")
  const totalTokens = numberOf(carried?.totalTokens, "totalTokens")
  const cachedPromptTokens = numberOf(carried?.cachedPromptTokens, "cachedPromptTokens")
  const cacheWritePromptTokens = numberOf(carried?.cacheWritePromptTokens, "cacheWritePromptTokens")
  const reasoningTokens = numberOf(carried?.reasoningTokens, "reasoningTokens")
  const providerReports = reportsOf(carried?.providerReports)
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
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
  let costUsd = 0
  let known = true
  let source: CostSource | undefined
  let provider: string | undefined
  let model: string | undefined
  const providerReports: ProviderUsageReport[] = []
  let first = true
  for (const part of parts) {
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
  const promptTokens = sumKnown((part) => part.promptTokens)
  const completionTokens = sumKnown((part) => part.completionTokens)
  const totalTokens = sumKnown((part) => part.totalTokens)
  const cachedPromptTokens = sumKnown((part) => part.cachedPromptTokens)
  const cacheWritePromptTokens = sumKnown((part) => part.cacheWritePromptTokens)
  const reasoningTokens = sumKnown((part) => part.reasoningTokens)
  const reportedCostUsd = sumKnown((part) => part.reportedCostUsd)
  const estimatedCostUsd = sumKnown((part) => part.estimatedCostUsd)
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
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
