import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnOf } from "@clavia/tardigrade-code/execution/turns"

export type CostSource = "provider" | "table"

// ProviderUsageReport keeps one physical request's provider metrics and serving coordinates.
export interface ProviderUsageReport {
  readonly provider?: string
  readonly model?: string
  readonly providerSpecific: unknown
}

// UsageAdapterIdentity identifies the contract that interpreted a provider report.
export interface UsageAdapterIdentity {
  readonly id: string
  readonly version: string
}

export interface UsageAccountingError {
  readonly kind: "adapter" | "aggregation"
  readonly message: string
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
  readonly usageAdapter?: UsageAdapterIdentity
  readonly accountingErrors?: ReadonlyArray<UsageAccountingError>
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
export type UsageAdapter = ((report: ProviderUsageReport) => Omit<Usage, "provider" | "model" | "providerReports"> | undefined) & {
  readonly usageAdapter?: UsageAdapterIdentity
}

// UsageAdapterDescriptor keeps a named interpretation beside its callable implementation.
export interface UsageAdapterDescriptor {
  readonly id: string
  readonly version: string
  readonly adapt: UsageAdapter
}

export type UsageAdapterSelection = UsageAdapter | UsageAdapterDescriptor

const numberOf = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (field.endsWith("Tokens") && !Number.isSafeInteger(value))) {
    throw new TypeError(`usage.${field} must be a non-negative ${field.endsWith("Tokens") ? "safe integer" : "finite number"}`)
  }
  return value
}

const openAiCount = (value: unknown, field: string): number | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`openai.chat-completions.${field} must be a non-negative safe integer`)
  }
  return value
}

const openAiObject = (value: unknown, field: string): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`openai.chat-completions.${field} must be an object`)
  }
  return value as Record<string, unknown>
}

const openAiDetails = (value: unknown, field: string): Record<string, unknown> | undefined =>
  value === null ? undefined : openAiObject(value, field)

const openAiSubset = (parent: number | undefined, child: number | undefined, field: string): void => {
  if (parent !== undefined && child !== undefined && child > parent) {
    throw new TypeError(`openai.chat-completions.${field} must be a subset of its total`)
  }
}

// OPENAI_CHAT_COMPLETIONS_USAGE_V1 interprets the documented Chat Completions usage object.
// Cached input tokens are included in prompt_tokens, and reasoning tokens are included in
// completion_tokens (usage.test.ts, "OpenAI Chat Completions usage preserves subsets").
export const OPENAI_CHAT_COMPLETIONS_USAGE_V1: UsageAdapterDescriptor = {
  id: "openai/chat-completions-usage",
  version: "1",
  adapt: (report) => {
    const raw = openAiObject(report.providerSpecific, "usage")
    if (raw === undefined) throw new TypeError("openai.chat-completions.usage must be an object")
    const promptTokens = openAiCount(raw.prompt_tokens, "prompt_tokens")
    const completionTokens = openAiCount(raw.completion_tokens, "completion_tokens")
    const totalTokens = openAiCount(raw.total_tokens, "total_tokens")
    const promptDetails = openAiDetails(raw.prompt_tokens_details, "prompt_tokens_details")
    const completionDetails = openAiDetails(raw.completion_tokens_details, "completion_tokens_details")
    const cachedPromptTokens = openAiCount(promptDetails?.cached_tokens, "prompt_tokens_details.cached_tokens")
    const cacheWritePromptTokens = openAiCount(promptDetails?.cache_write_tokens, "prompt_tokens_details.cache_write_tokens")
    const reasoningTokens = openAiCount(completionDetails?.reasoning_tokens, "completion_tokens_details.reasoning_tokens")
    openAiSubset(promptTokens, cachedPromptTokens, "prompt_tokens_details.cached_tokens")
    openAiSubset(promptTokens, cacheWritePromptTokens, "prompt_tokens_details.cache_write_tokens")
    openAiSubset(completionTokens, reasoningTokens, "completion_tokens_details.reasoning_tokens")
    openAiSubset(totalTokens, promptTokens, "prompt_tokens")
    openAiSubset(totalTokens, completionTokens, "completion_tokens")
    if (totalTokens !== undefined && promptTokens !== undefined && completionTokens !== undefined && totalTokens !== promptTokens + completionTokens) {
      throw new TypeError("openai.chat-completions.total_tokens must equal prompt_tokens plus completion_tokens")
    }
    return {
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
      ...(cacheWritePromptTokens === undefined ? {} : { cacheWritePromptTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens })
    }
  }
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

const adapterOf = (selection: UsageAdapterSelection | undefined): UsageAdapter | undefined => {
  if (selection === undefined) return undefined
  if (typeof selection === "function") {
    const identity = selection.usageAdapter
    if (identity !== undefined && !isAdapterIdentity(identity)) throw new TypeError("usage adapter identity must contain non-empty string id and version")
    return selection
  }
  if (!isAdapterDescriptor(selection)) {
    throw new TypeError("usage adapter descriptor must contain non-empty string id, version, and adapt")
  }
  return selection.adapt
}

const isAdapterIdentity = (value: unknown): value is UsageAdapterIdentity => {
  const record = asRecord(value)
  return record !== undefined && !Array.isArray(value) && typeof record.id === "string" && record.id !== "" && typeof record.version === "string" && record.version !== ""
}

const isAdapterDescriptor = (value: unknown): value is UsageAdapterDescriptor =>
  isAdapterIdentity(value) && typeof (value as { readonly adapt?: unknown }).adapt === "function"

// validateUsageAdapterSelection rejects malformed runtime configuration before a model request
// can dispatch (usage.test.ts, "invalid adapter descriptors fail before fetch").
export const validateUsageAdapterSelection = (selection: unknown): void => {
  if (selection !== undefined) adapterOf(selection as UsageAdapterSelection)
}

const adapterIdentityOf = (selection: UsageAdapterSelection | undefined): UsageAdapterIdentity | undefined => {
  if (selection === undefined) return undefined
  adapterOf(selection)
  return typeof selection === "function" ? selection.usageAdapter : { id: selection.id, version: selection.version }
}

const safeAdapterIdentityOf = (selection: unknown): UsageAdapterIdentity | undefined => {
  if (typeof selection === "function") {
    const identity = (selection as { readonly usageAdapter?: unknown }).usageAdapter
    return isAdapterIdentity(identity) ? identity : undefined
  }
  return isAdapterIdentity(selection) ? { id: selection.id, version: selection.version } : undefined
}

// usageFrom preserves a raw report and applies an adapter only when the caller supplies one (usage.test.ts, "raw reports stay uninterpreted by default").
export const usageFrom = (report: ProviderUsageReport, adapter?: UsageAdapterSelection): Usage => {
  if (asRecord(report) === undefined || !("providerSpecific" in report)) {
    throw new TypeError("usageFrom requires a ProviderUsageReport with providerSpecific")
  }
  const { provider: _provider, model: _model, providerReports: _reports, ...metrics } = usageOf(adapterOf(adapter)?.(report))
  const identity = adapterIdentityOf(adapter)
  return {
    ...metrics,
    ...(report.provider === undefined ? {} : { provider: report.provider }),
    ...(report.model === undefined ? {} : { model: report.model }),
    ...(identity === undefined ? {} : { usageAdapter: identity }),
    providerReports: [report]
  }
}

// usageWithAccountingError preserves the selected descriptor while withholding its invalid
// interpretation from numeric metrics (usage.test.ts, "adapter errors retain provenance").
export const usageWithAccountingError = (report: ProviderUsageReport, adapter: UsageAdapterSelection | undefined, message: string): Usage => {
  const identity = safeAdapterIdentityOf(adapter)
  return {
    ...usageFrom(report),
    ...(identity === undefined ? {} : { usageAdapter: identity }),
    accountingErrors: [{ kind: "adapter", message }]
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
  const usageAdapterValue = carried?.usageAdapter
  const usageAdapterRecord = usageAdapterValue === undefined ? undefined : asRecord(usageAdapterValue)
  if (usageAdapterValue !== undefined && (usageAdapterRecord === undefined || typeof usageAdapterRecord.id !== "string" || typeof usageAdapterRecord.version !== "string")) {
    throw new TypeError("usage.usageAdapter must contain string id and version")
  }
  const accountingErrorsValue = carried?.accountingErrors
  if (accountingErrorsValue !== undefined && !Array.isArray(accountingErrorsValue)) {
    throw new TypeError("usage.accountingErrors must be an array")
  }
  const accountingErrors = accountingErrorsValue?.map((error) => {
    const record = asRecord(error)
    if (record === undefined || (record.kind !== "adapter" && record.kind !== "aggregation") || typeof record.message !== "string") {
      throw new TypeError("usage.accountingErrors must contain typed accounting errors")
    }
    return { kind: record.kind as "adapter" | "aggregation", message: record.message }
  })
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
    ...(usageAdapterRecord === undefined ? {} : { usageAdapter: { id: usageAdapterRecord.id as string, version: usageAdapterRecord.version as string } }),
    ...(accountingErrors === undefined ? {} : { accountingErrors }),
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
  let source: CostSource | undefined
  let provider: string | undefined
  let model: string | undefined
  const providerReports: ProviderUsageReport[] = []
  const accountingErrors: UsageAccountingError[] = []
  let usageAdapter: UsageAdapterIdentity | undefined
  let mixedAdapters = false
  let missingAdapter = false
  let first = true
  for (const part of parts) {
    providerReports.push(...(part.providerReports ?? []))
    accountingErrors.push(...(part.accountingErrors ?? []))
    if (part.usageAdapter !== undefined) {
      if (missingAdapter) mixedAdapters = true
      if (usageAdapter === undefined) usageAdapter = part.usageAdapter
      else if (usageAdapter.id !== part.usageAdapter.id || usageAdapter.version !== part.usageAdapter.version) mixedAdapters = true
    } else {
      if (usageAdapter !== undefined) mixedAdapters = true
      missingAdapter = true
    }
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
  const sumMetric = (read: (part: Usage) => number | undefined, name: string): number | undefined => {
    let total = 0
    for (const part of parts) {
      const value = read(part)
      if (value === undefined) return undefined
      const next = total + value
      if (!Number.isFinite(next) || (name.endsWith("Tokens") && !Number.isSafeInteger(next))) {
        accountingErrors.push({ kind: "aggregation", message: `${name} aggregation exceeded its numeric range` })
        return undefined
      }
      total = next
    }
    return total
  }
  const costUsd = sumMetric((part) => part.costUsd, "costUsd")
  const known = costUsd !== undefined
  const promptTokens = sumMetric((part) => part.promptTokens, "promptTokens")
  const completionTokens = sumMetric((part) => part.completionTokens, "completionTokens")
  const totalTokens = sumMetric((part) => part.totalTokens, "totalTokens")
  const cachedPromptTokens = sumMetric((part) => part.cachedPromptTokens, "cachedPromptTokens")
  const cacheWritePromptTokens = sumMetric((part) => part.cacheWritePromptTokens, "cacheWritePromptTokens")
  const reasoningTokens = sumMetric((part) => part.reasoningTokens, "reasoningTokens")
  const reportedCostUsd = sumMetric((part) => part.reportedCostUsd, "reportedCostUsd")
  const estimatedCostUsd = sumMetric((part) => part.estimatedCostUsd, "estimatedCostUsd")
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
    ...(mixedAdapters || usageAdapter === undefined ? {} : { usageAdapter }),
    ...(accountingErrors.length === 0 ? {} : { accountingErrors }),
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

export const DEFAULT_USAGE_COVERAGE_METRICS = ["promptTokens", "completionTokens"] as const
export type UsageCoverageMetric =
  | "promptTokens"
  | "completionTokens"
  | "totalTokens"
  | "cachedPromptTokens"
  | "cacheWritePromptTokens"
  | "reasoningTokens"
  | "costUsd"
  | "reportedCostUsd"
  | "estimatedCostUsd"
export const USAGE_COVERAGE_SCOPE = "framework-recorded-inference-invocations" as const

export interface UsageCoverageOptions {
  readonly required?: ReadonlyArray<UsageCoverageMetric>
}

export interface UsageCoverageGap {
  readonly reason: "missing-consequence" | "missing-usage" | "missing-metrics"
  readonly turn: string
  readonly epoch: number
  readonly callId: string
  readonly ordinal?: number
  readonly metrics: ReadonlyArray<UsageCoverageMetric>
}

export interface UsageCoverageUnresolved {
  readonly reason: "accounting-error" | "duplicate-consequence" | "unmatched-consequence"
  readonly turn: string
  readonly epoch: number
  readonly callId?: string
  readonly ordinal?: number
  readonly message?: string
}

type CoverageTotal<M extends ReadonlyArray<UsageCoverageMetric>> =
  number extends M["length"]
    ? Partial<Record<UsageCoverageMetric, number>>
    : { readonly [K in M[number]]: number }

export interface CompleteUsageCoverage {
  readonly status: "complete"
  readonly scope: typeof USAGE_COVERAGE_SCOPE
  readonly observed: Usage
  readonly total: CoverageTotal<typeof DEFAULT_USAGE_COVERAGE_METRICS>
  readonly missing: ReadonlyArray<never>
  readonly unresolved: ReadonlyArray<never>
}

export interface IncompleteUsageCoverage {
  readonly status: "incomplete"
  readonly scope: typeof USAGE_COVERAGE_SCOPE
  readonly observed: Usage
  readonly missing: ReadonlyArray<UsageCoverageGap>
  readonly unresolved: ReadonlyArray<UsageCoverageUnresolved>
  readonly total?: never
}

export type UsageCoverage<M extends ReadonlyArray<UsageCoverageMetric> = typeof DEFAULT_USAGE_COVERAGE_METRICS> =
  | (Omit<CompleteUsageCoverage, "total"> & { readonly total: CoverageTotal<M> })
  | IncompleteUsageCoverage

interface NativeCall {
  readonly eventIndex: number
  readonly turn: string
  readonly epoch: number
  readonly callId: string
  readonly ordinal: number | undefined
  readonly usage?: Usage
  matched: boolean
}

interface MatchedUsage {
  readonly call: NativeCall
  readonly eventIndex: number
  readonly usage: Usage | undefined
}

const epochOf = (event: Event): number => {
  const epoch = asRecord(event)?.epoch
  return typeof epoch === "number" && Number.isFinite(epoch) ? epoch : 0
}

const attemptKeyOf = (event: Event): string | undefined => {
  const value = asRecord(event)?.attemptKey ?? asRecord(event)?.attempt
  return typeof value === "string" ? value : undefined
}

const isConsequence = (event: Event): boolean =>
  event.type === "ToolCalled" || event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "OutputRejected"

const metricOf = (usage: Usage | undefined, metric: UsageCoverageMetric): number | undefined =>
  usage?.[metric]

const subtotalOf = (parts: ReadonlyArray<Usage>): Usage => {
  if (parts.length === 0) return {}
  const errors = parts.flatMap((part) => part.accountingErrors ?? [])
  const sumKnown = (metric: UsageCoverageMetric): number | undefined => {
    let total = 0
    let found = false
    for (const part of parts) {
      const value = metricOf(part, metric)
      if (value !== undefined) {
        const next = total + value
        if (!Number.isFinite(next) || (metric.endsWith("Tokens") && !Number.isSafeInteger(next))) {
          errors.push({ kind: "aggregation", message: `${metric} aggregation exceeded its numeric range` })
          return undefined
        }
        total = next
        found = true
      }
    }
    return found ? total : undefined
  }
  const firstProvider = parts[0]?.provider
  const firstModel = parts[0]?.model
  const provider = parts.every((part) => part.provider === firstProvider) ? firstProvider : undefined
  const model = parts.every((part) => part.model === firstModel) ? firstModel : undefined
  const reports = parts.flatMap((part) => part.providerReports ?? [])
  const adapters = parts.map((part) => part.usageAdapter).filter((adapter): adapter is UsageAdapterIdentity => adapter !== undefined)
  const adapter = adapters.length > 0 && adapters.every((candidate) => candidate.id === adapters[0]!.id && candidate.version === adapters[0]!.version) && parts.every((part) => part.usageAdapter !== undefined)
    ? adapters[0]
    : undefined
  const promptTokens = sumKnown("promptTokens")
  const completionTokens = sumKnown("completionTokens")
  const sumOptional = (metric: UsageCoverageMetric): number | undefined => sumKnown(metric)
  const costUsd = sumKnown("costUsd")
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(["totalTokens", "cachedPromptTokens", "cacheWritePromptTokens", "reasoningTokens", "reportedCostUsd", "estimatedCostUsd"] as const).reduce<Record<string, number>>((result, metric) => {
      const value = sumOptional(metric)
      if (value !== undefined) result[metric] = value
      return result
    }, {}),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(adapter === undefined ? {} : { usageAdapter: adapter }),
    ...(errors.length === 0 ? {} : { accountingErrors: errors }),
    ...(reports.length === 0 ? {} : { providerReports: reports })
  }
}

const validCoverageMetrics = (required: ReadonlyArray<UsageCoverageMetric> | undefined): ReadonlyArray<UsageCoverageMetric> => {
  const metrics = required ?? DEFAULT_USAGE_COVERAGE_METRICS
  if (metrics.length === 0 || new Set(metrics).size !== metrics.length || metrics.some((metric) => !["promptTokens", "completionTokens", "totalTokens", "cachedPromptTokens", "cacheWritePromptTokens", "reasoningTokens", "costUsd", "reportedCostUsd", "estimatedCostUsd"].includes(metric))) {
    throw new TypeError("usage coverage required metrics must be a non-empty list of declared numeric usage metrics")
  }
  return metrics
}

const totalOf = <M extends ReadonlyArray<UsageCoverageMetric>>(observed: Usage, required: M, empty: boolean): CoverageTotal<M> => {
  const total: Record<string, number> = {}
  for (const metric of required) {
    const value = observed[metric]
    if (value === undefined && !empty) throw new Error(`coverage total is missing required metric ${metric}`)
    total[metric] = value ?? 0
  }
  return total as CoverageTotal<M>
}

interface NativeEvidenceProjection {
  readonly calls: ReadonlyArray<NativeCall>
  readonly matched: ReadonlyArray<MatchedUsage>
  readonly unresolved: ReadonlyArray<UsageCoverageUnresolved>
}

const nativeProjectionIn = (log: ReadonlyArray<Event>, turn: string): NativeEvidenceProjection => {
  const calls: NativeCall[] = []
  for (const [eventIndex, event] of log.entries()) {
    if (event.type !== "ModelCalled" || !ofTurn(event, turn)) continue
    const value = asRecord(event)!
    calls.push({
      eventIndex,
      turn,
      epoch: epochOf(event),
      callId: String(value.callId ?? ""),
      ordinal: typeof value.ordinal === "number" ? value.ordinal : undefined,
      matched: false
    })
  }
  const matched: MatchedUsage[] = []
  const unresolved: UsageCoverageUnresolved[] = []
  const matchedUsage = new Map<NativeCall, Usage | undefined>()
  for (const [eventIndex, event] of log.entries()) {
    if (!isConsequence(event) || !ofTurn(event, turn)) continue
    const value = asRecord(event)!
    const key = attemptKeyOf(event)
    if (key === undefined && event.type !== "ToolCalled") continue
    const epoch = epochOf(event)
    const candidates = calls.filter((call) => call.eventIndex < eventIndex && call.epoch === epoch && (key === undefined || call.callId === key))
    const call = candidates.at(-1)
    if (call === undefined) {
      if (key !== undefined) {
        unresolved.push({ reason: "unmatched-consequence", turn, epoch, callId: key })
      }
      continue
    }
    const rawUsage = value.usage
    const usage = rawUsage === undefined ? undefined : usageOf(rawUsage)
    const previous = matchedUsage.get(call)
    if (matchedUsage.has(call)) {
      if (JSON.stringify(previous) !== JSON.stringify(usage)) {
        unresolved.push({ reason: "duplicate-consequence", turn, epoch, callId: call.callId, ...(call.ordinal === undefined ? {} : { ordinal: call.ordinal }), message: "conflicting duplicate consequence" })
      }
      continue
    }
    call.matched = true
    matchedUsage.set(call, usage)
    matched.push({ call, eventIndex, usage })
  }
  return { calls, matched, unresolved }
}

// coverageIn projects only durable ModelCalled marks and their native consequences. A repeated
// mark is a distinct occurrence, so a later terminal cannot settle an earlier crash (usage.test.ts,
// "repeated native marks leave the earlier occurrence unresolved").
export function coverageIn(log: ReadonlyArray<Event>, turn: string, options?: UsageCoverageOptions & { readonly required?: typeof DEFAULT_USAGE_COVERAGE_METRICS }): UsageCoverage
export function coverageIn<const M extends ReadonlyArray<UsageCoverageMetric>>(log: ReadonlyArray<Event>, turn: string, options: UsageCoverageOptions & { readonly required: M }): UsageCoverage<M>
export function coverageIn<M extends ReadonlyArray<UsageCoverageMetric>>(log: ReadonlyArray<Event>, turn: string, options: UsageCoverageOptions = {}): UsageCoverage<M> {
  const required = validCoverageMetrics(options.required) as M
  const projection = nativeProjectionIn(log, turn)
  const { calls, matched } = projection
  const unresolved: UsageCoverageUnresolved[] = [...projection.unresolved]
  const missing: UsageCoverageGap[] = []
  const evidence: Usage[] = []
  for (const call of calls) {
    const answer = matched.find((candidate) => candidate.call === call)
    if (answer === undefined) {
      missing.push({ reason: "missing-consequence", turn, epoch: call.epoch, callId: call.callId, ...(call.ordinal === undefined ? {} : { ordinal: call.ordinal }), metrics: required })
      continue
    }
    if (answer.usage === undefined) {
      missing.push({ reason: "missing-usage", turn, epoch: call.epoch, callId: call.callId, ...(call.ordinal === undefined ? {} : { ordinal: call.ordinal }), metrics: required })
      continue
    }
    evidence.push(answer.usage)
    const absent = required.filter((metric) => metricOf(answer.usage, metric) === undefined)
    if (absent.length > 0) {
      missing.push({ reason: "missing-metrics", turn, epoch: call.epoch, callId: call.callId, ...(call.ordinal === undefined ? {} : { ordinal: call.ordinal }), metrics: absent })
    }
    for (const error of answer.usage.accountingErrors ?? []) {
      unresolved.push({ reason: "accounting-error", turn, epoch: call.epoch, callId: call.callId, ...(call.ordinal === undefined ? {} : { ordinal: call.ordinal }), message: error.message })
    }
  }
  const observed = subtotalOf(evidence)
  for (const error of observed.accountingErrors ?? []) {
    if (error.kind === "aggregation") unresolved.push({ reason: "accounting-error", turn, epoch: 0, message: error.message })
  }
  const complete = missing.length === 0 && unresolved.length === 0 && required.every((metric) => calls.length === 0 || observed[metric] !== undefined)
  if (complete) return { status: "complete", scope: USAGE_COVERAGE_SCOPE, observed, total: totalOf(observed, required, calls.length === 0), missing: [], unresolved: [] }
  return { status: "incomplete", scope: USAGE_COVERAGE_SCOPE, observed, missing, unresolved }
}

const nativeUsagePartsIn = (log: ReadonlyArray<Event>, turn: string): ReadonlyArray<Usage> => {
  const projection = nativeProjectionIn(log, turn)
  const parts: Usage[] = projection.matched.flatMap((match) => {
    if (match.usage === undefined) return [{}]
    return match.usage.accountingErrors === undefined ? [match.usage] : [match.usage, {}]
  })
  for (const call of projection.calls) if (!call.matched) parts.push({})
  for (const _unresolved of projection.unresolved) parts.push({})
  return parts
}

// usageIn retains its compatibility shape while refusing an exact metric when native coverage
// is incomplete. coverageIn exposes the observed subtotal and the reason for that uncertainty.
export const usageIn = (log: ReadonlyArray<Event>, turn: string): Usage => {
  const native = log.some((event) => event.type === "ModelCalled" && ofTurn(event, turn))
  if (!native) {
    return sumUsage(log.flatMap((event) => {
      if (!ofTurn(event, turn)) return []
      const carried = asRecord(event)?.usage
      return carried === undefined ? [] : [usageOf(carried)]
    }))
  }
  return sumUsage(nativeUsagePartsIn(log, turn))
}
