import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnOf } from "@clavia/tardigrade-code/execution/turns"

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
export const ModelPricing = Schema.Struct({
  promptUsdPerToken: Schema.Finite,
  completionUsdPerToken: Schema.Finite,
  cachedPromptUsdPerToken: Schema.optionalKey(Schema.Finite),
  cacheWritePromptUsdPerToken: Schema.optionalKey(Schema.Finite)
})
export type ModelPricing = typeof ModelPricing.Type

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

export const costOf = (
  pricing: ModelPricing | undefined,
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  cachedPromptTokens: number = 0,
  cacheWritePromptTokens: number = 0
): number | undefined => {
  if (pricing === undefined || promptTokens === undefined || completionTokens === undefined) return undefined
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
  const original = asRecord(value)
  const input = asRecord(original?.inputTokens)
  const output = asRecord(original?.outputTokens)
  const carried = input === undefined && output === undefined ? original : {
    ...original,
    promptTokens: input?.total,
    completionTokens: output?.total,
    cachedPromptTokens: input?.cacheRead,
    cacheWritePromptTokens: input?.cacheWrite,
    reasoningTokens: output?.reasoning,
    ...(typeof input?.total === "number" && typeof output?.total === "number" ? { totalTokens: input.total + output.total } : {})
  }
  const costUsd = numberOf(carried?.costUsd)
  const source = carried?.costSource
  const provider = carried?.provider
  const model = carried?.model
  const reportedCostUsd = numberOf(carried?.reportedCostUsd)
  const estimatedCostUsd = numberOf(carried?.estimatedCostUsd)
  const promptTokens = numberOf(carried?.promptTokens)
  const completionTokens = numberOf(carried?.completionTokens)
  const totalTokens = numberOf(carried?.totalTokens)
  const cachedPromptTokens = numberOf(carried?.cachedPromptTokens)
  const cacheWritePromptTokens = numberOf(carried?.cacheWritePromptTokens)
  const reasoningTokens = numberOf(carried?.reasoningTokens)
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

// usageIn sums response usage and legacy consequence usage for one turn (usage.test.ts).
// Missing usage is not spend; an empty usage object retains unknown spend.
export const usageIn = (log: ReadonlyArray<Event>, turn: string): Usage =>
  sumUsage(
    log.flatMap((event) => {
      if (!ofTurn(event, turn)) return []
      const carried = event.legacyUsage ?? event.usage
      if (carried === undefined) return []
      const called = event.type === "ModelReturned" ? log.find((mark) => mark.type === "ModelCalled" && mark.turn === event.turn && mark.ordinal === event.ordinal) : undefined
      const recordedPricing = called?.pricing ?? asRecord(called?.policy)?.pricing
      const pricing = Schema.is(ModelPricing)(recordedPricing) ? recordedPricing : undefined
      const endpoint = asRecord(event.endpoint)
      const response = asRecord(event.response)
      const usage = usageOf({ ...(endpoint?.provider === undefined ? {} : { provider: endpoint.provider }), ...(response?.modelId === undefined && endpoint?.model === undefined ? {} : { model: response?.modelId ?? endpoint?.model }), ...asRecord(carried), ...(event.reportedCostUsd === undefined ? {} : { reportedCostUsd: event.reportedCostUsd, costUsd: event.reportedCostUsd, costSource: "provider" }) })
      return [pricing === undefined ? usage : priced(usage, pricing)]
    })
  )
