import type { Event } from "@tardigrade/core/event"
import { turnOf } from "@tardigrade/code/turns"

// Usage is what one model attempt spent. costUsd is present when the figure is known.
// costSource is how that figure was obtained: the provider billed it, or a price table
// filled it from token counts. A reported zero is free. Absence of costUsd is unknown.
// provider and model name who was called, so a later switch cannot rewrite the stamp
// (usage.test.ts, "a reported cost keeps its source").

export type CostSource = "provider" | "table"

export interface Usage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly costUsd?: number
  readonly costSource?: CostSource
  readonly provider?: string
  readonly model?: string
}

export interface ModelPricing {
  readonly promptUsdPerToken: number
  readonly completionUsdPerToken: number
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

// costNumber reads a provider-billed dollar amount from a usage object. Gateways disagree on
// the field name, so every common seat is checked; a table fill never writes these keys.
export const costNumber = (value: unknown): number | undefined => {
  const rec = asRecord(value)
  if (rec === undefined) return undefined
  const direct = firstNumber(rec, ["cost", "costUsd", "total_cost", "cost_usd"])
  if (direct !== undefined) return direct
  return costNumber(rec.gateway)
}

const tokensOf = (value: unknown): { readonly promptTokens: number; readonly completionTokens: number } | undefined => {
  const rec = asRecord(value)
  if (rec === undefined) return undefined
  const prompt = firstNumber(rec, ["promptTokens", "prompt_tokens", "inputTokens", "input_tokens"])
  const completion = firstNumber(rec, ["completionTokens", "completion_tokens", "outputTokens", "output_tokens"])
  if (prompt === undefined && completion === undefined) return undefined
  return { promptTokens: prompt ?? 0, completionTokens: completion ?? 0 }
}

export const costOf = (
  pricing: ModelPricing | undefined,
  promptTokens: number,
  completionTokens: number
): number | undefined =>
  pricing === undefined
    ? undefined
    : promptTokens * pricing.promptUsdPerToken + completionTokens * pricing.completionUsdPerToken

// priced keeps a cost that is already present, including zero, and fills from the table only
// when nobody billed a figure. The fill is labeled table so a later reader can tell it from a
// provider bill (usage.test.ts, "a price table fills an omitted cost").
export const priced = (usage: Usage, pricing?: ModelPricing): Usage => {
  if (usage.costUsd !== undefined) return usage
  const costUsd = costOf(pricing, usage.promptTokens, usage.completionTokens)
  return costUsd === undefined ? usage : { ...usage, costUsd, costSource: "table" }
}

// usageFrom builds spend from a provider reply. A billed dollar, including zero, is provider.
// Token counts with no bill are filled from the table when one exists, and left without a
// cost when none does. Nothing at all (no tokens, no bill) is undefined: unknown, not zero.
export const usageFrom = (
  reported: unknown,
  pricing?: ModelPricing,
  stamp?: { readonly provider?: string; readonly model?: string }
): Usage | undefined => {
  const parts = Array.isArray(reported) ? reported : [reported]
  let tokens: { readonly promptTokens: number; readonly completionTokens: number } | undefined
  let billed: number | undefined
  for (const part of parts) {
    const next = tokensOf(part)
    if (next !== undefined) tokens = next
    const cost = costNumber(part)
    if (cost !== undefined) billed = cost
  }
  if (tokens === undefined && billed === undefined) return undefined
  return priced(
    {
      promptTokens: tokens?.promptTokens ?? 0,
      completionTokens: tokens?.completionTokens ?? 0,
      ...(stamp?.provider === undefined ? {} : { provider: stamp.provider }),
      ...(stamp?.model === undefined ? {} : { model: stamp.model }),
      ...(billed === undefined ? {} : { costUsd: billed, costSource: "provider" as const })
    },
    pricing
  )
}

export const usageOf = (value: unknown): Usage => {
  const carried = asRecord(value)
  const costUsd = numberOf(carried?.costUsd)
  const source = carried?.costSource
  const provider = carried?.provider
  const model = carried?.model
  return {
    promptTokens: numberOf(carried?.promptTokens) ?? 0,
    completionTokens: numberOf(carried?.completionTokens) ?? 0,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(costUsd !== undefined && (source === "provider" || source === "table") ? { costSource: source } : {}),
    ...(typeof provider === "string" && provider !== "" ? { provider } : {}),
    ...(typeof model === "string" && model !== "" ? { model } : {})
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
  let first = true
  for (const part of parts) {
    promptTokens += part.promptTokens
    completionTokens += part.completionTokens
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
  return {
    promptTokens,
    completionTokens,
    ...(known ? { costUsd, ...(source === undefined ? {} : { costSource: source }) } : {}),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model })
  }
}

// usageIn sums what one turn spent on the model. Settled figures come from ModelReturned.
// An attempt that died after ModelCalled has no return, so it does not invent a cost.
export const usageIn = (log: ReadonlyArray<Event>, turn: string): Usage =>
  sumUsage(
    log.flatMap((event) => {
      if (event.type !== "ModelReturned" || turnOf(event) !== turn) return []
      const carried = asRecord(event)?.usage
      return carried === undefined ? [] : [usageOf(carried)]
    })
  )
