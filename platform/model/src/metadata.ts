import type { OutputCapability } from "./output"
import type { ModelPricing } from "tardie/usage"

export type ModelMetadataSource =
  | { readonly kind: "declared"; readonly owner: string }
  | { readonly kind: "discovered"; readonly url: string; readonly revision?: string }
  | { readonly kind: "managed"; readonly catalog: string; readonly revision: string }

export interface MetadataValue<T> {
  readonly value: T
  readonly source: ModelMetadataSource
}

export interface ModelMetadata {
  readonly contextWindowTokens?: MetadataValue<number>
  readonly maxOutputTokens?: MetadataValue<number>
  readonly pricing?: MetadataValue<ModelPricing>
  readonly output?: MetadataValue<OutputCapability>
  readonly inputModalities?: MetadataValue<ReadonlyArray<string>>
  readonly outputModalities?: MetadataValue<ReadonlyArray<string>>
}

export interface DiscoveredModel {
  readonly id: string
  readonly name?: string
  readonly metadata: ModelMetadata
}

export interface DeclaredModelMetadata {
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly pricing?: ModelPricing
  readonly output?: OutputCapability
  readonly inputModalities?: ReadonlyArray<string>
  readonly outputModalities?: ReadonlyArray<string>
}

export const metadataValue = <T>(value: T, source: ModelMetadataSource): MetadataValue<T> => ({ value, source })

export const declaredModelMetadata = (
  values: DeclaredModelMetadata,
  owner: string
): ModelMetadata & { readonly contextWindowTokens: MetadataValue<number> } => {
  const source: ModelMetadataSource = { kind: "declared", owner }
  if (!Number.isSafeInteger(values.contextWindowTokens) || values.contextWindowTokens <= 0) {
    throw new Error(`contextWindowTokens must be a positive integer, got ${values.contextWindowTokens}`)
  }
  if (values.maxOutputTokens !== undefined && (!Number.isSafeInteger(values.maxOutputTokens) || values.maxOutputTokens <= 0)) {
    throw new Error(`maxOutputTokens must be a positive integer, got ${values.maxOutputTokens}`)
  }
  return {
    contextWindowTokens: metadataValue(values.contextWindowTokens, source),
    ...(values.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadataValue(values.maxOutputTokens, source) }),
    ...(values.pricing === undefined ? {} : { pricing: metadataValue(values.pricing, source) }),
    ...(values.output === undefined ? {} : { output: metadataValue(values.output, source) }),
    ...(values.inputModalities === undefined ? {} : { inputModalities: metadataValue(values.inputModalities, source) }),
    ...(values.outputModalities === undefined ? {} : { outputModalities: metadataValue(values.outputModalities, source) })
  }
}

export const mergeModelMetadata = (...layers: ReadonlyArray<ModelMetadata>): ModelMetadata => {
  const merged: ModelMetadata = {}
  for (const layer of layers) Object.assign(merged, layer)
  return merged
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined

const positiveNumber = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN
  return Number.isFinite(number) && number > 0 ? number : undefined
}

const positiveInteger = (value: unknown): number | undefined => {
  const number = positiveNumber(value)
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined
}

const firstInteger = (record: Record<string, unknown>, names: ReadonlyArray<string>): number | undefined => {
  for (const name of names) {
    const value = positiveInteger(record[name])
    if (value !== undefined) return value
  }
  return undefined
}

const strings = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined
  const found = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
  return found.length === 0 ? undefined : found
}

const pricingOf = (value: unknown): ModelPricing | undefined => {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const promptUsdPerToken = positiveNumber(record["prompt"] ?? record["input"])
  const completionUsdPerToken = positiveNumber(record["completion"] ?? record["output"])
  if (promptUsdPerToken === undefined || completionUsdPerToken === undefined) return undefined
  const cachedPromptUsdPerToken = positiveNumber(record["input_cache_read"] ?? record["cached_prompt"])
  const cacheWritePromptUsdPerToken = positiveNumber(record["input_cache_write"] ?? record["cache_write_prompt"])
  return {
    promptUsdPerToken,
    completionUsdPerToken,
    ...(cachedPromptUsdPerToken === undefined ? {} : { cachedPromptUsdPerToken }),
    ...(cacheWritePromptUsdPerToken === undefined ? {} : { cacheWritePromptUsdPerToken })
  }
}

const outputOf = (value: unknown): OutputCapability | undefined => {
  const parameters = strings(value)
  if (parameters === undefined) return undefined
  if (!parameters.includes("structured_outputs") && !parameters.includes("response_format")) return undefined
  return { guarantee: "native", withTools: parameters.includes("tools") }
}

export const discoveredModelOf = (raw: unknown, source: ModelMetadataSource): DiscoveredModel | undefined => {
  const record = recordOf(raw)
  if (record === undefined || typeof record["id"] !== "string" || record["id"].trim().length === 0) return undefined
  const top = recordOf(record["top_provider"])
  const architecture = recordOf(record["architecture"])
  const contextWindowTokens = firstInteger(record, ["context_window", "context_length", "context_window_tokens"])
    ?? (top === undefined ? undefined : firstInteger(top, ["context_length"]))
  const maxOutputTokens = firstInteger(record, ["max_tokens", "max_output_tokens", "max_completion_tokens"])
    ?? (top === undefined ? undefined : firstInteger(top, ["max_completion_tokens"]))
  const pricing = pricingOf(record["pricing"])
  const output = outputOf(record["supported_parameters"])
  const inputModalities = strings(record["input_modalities"])
    ?? (architecture === undefined ? undefined : strings(architecture["input_modalities"]))
  const outputModalities = strings(record["output_modalities"])
    ?? (architecture === undefined ? undefined : strings(architecture["output_modalities"]))
  const name = typeof record["name"] === "string" && record["name"].trim().length > 0 ? record["name"].trim() : undefined
  return {
    id: record["id"].trim(),
    ...(name === undefined ? {} : { name }),
    metadata: {
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens: metadataValue(contextWindowTokens, source) }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: metadataValue(maxOutputTokens, source) }),
      ...(pricing === undefined ? {} : { pricing: metadataValue(pricing, source) }),
      ...(output === undefined ? {} : { output: metadataValue(output, source) }),
      ...(inputModalities === undefined ? {} : { inputModalities: metadataValue(inputModalities, source) }),
      ...(outputModalities === undefined ? {} : { outputModalities: metadataValue(outputModalities, source) })
    }
  }
}

export const discoveredModelsOf = (raw: unknown, source: ModelMetadataSource): ReadonlyArray<DiscoveredModel> => {
  const record = recordOf(raw)
  if (record === undefined) return []
  const rows = Array.isArray(record["data"]) ? record["data"] : Array.isArray(record["models"]) ? record["models"] : []
  const found = new Map<string, DiscoveredModel>()
  for (const row of rows) {
    if (typeof row === "string") {
      const id = row.trim()
      if (id.length > 0) found.set(id, { id, metadata: {} })
      continue
    }
    const model = discoveredModelOf(row, source)
    if (model !== undefined) found.set(model.id, model)
  }
  return [...found.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export const requireModelMetadata = (model: DiscoveredModel): DiscoveredModel & {
  readonly metadata: ModelMetadata & { readonly contextWindowTokens: MetadataValue<number> }
} => {
  if (model.metadata.contextWindowTokens === undefined) {
    throw new Error(`model ${JSON.stringify(model.id)} has no declared context window`)
  }
  return model as DiscoveredModel & {
    readonly metadata: ModelMetadata & { readonly contextWindowTokens: MetadataValue<number> }
  }
}
