import type { OutputCapability } from "./output"
import type { ModelPricing } from "tardie/usage"

export const DEFAULT_MODEL_CATALOG_URL = "https://models.dev/api.json"

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
  // output is an operator guarantee. Community capability data cannot establish withTools.
  readonly output?: MetadataValue<OutputCapability>
  readonly toolCall?: MetadataValue<boolean>
  readonly structuredOutput?: MetadataValue<boolean>
  readonly inputModalities?: MetadataValue<ReadonlyArray<string>>
  readonly outputModalities?: MetadataValue<ReadonlyArray<string>>
}

export interface DiscoveredModel {
  readonly id: string
  readonly name?: string
  readonly metadata: ModelMetadata
}

export interface DiscoveredProvider {
  readonly id: string
  readonly name: string
  readonly api?: string
  readonly npm?: string
  readonly env: ReadonlyArray<string>
  readonly models: ReadonlyArray<DiscoveredModel>
}

export interface DeclaredModelMetadata {
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly pricing?: ModelPricing
  readonly output?: OutputCapability
  readonly toolCall?: boolean
  readonly structuredOutput?: boolean
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
    ...(values.toolCall === undefined ? {} : { toolCall: metadataValue(values.toolCall, source) }),
    ...(values.structuredOutput === undefined ? {} : { structuredOutput: metadataValue(values.structuredOutput, source) }),
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

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : []

const pricingOf = (value: unknown): ModelPricing | undefined => {
  const cost = recordOf(value)
  if (cost === undefined || typeof cost["input"] !== "number" || typeof cost["output"] !== "number") return undefined
  return {
    promptUsdPerToken: cost["input"] / 1_000_000,
    completionUsdPerToken: cost["output"] / 1_000_000,
    ...(typeof cost["cache_read"] === "number" ? { cachedPromptUsdPerToken: cost["cache_read"] / 1_000_000 } : {}),
    ...(typeof cost["cache_write"] === "number" ? { cacheWritePromptUsdPerToken: cost["cache_write"] / 1_000_000 } : {})
  }
}

export const modelsDevModelOf = (raw: unknown, source: ModelMetadataSource): DiscoveredModel | undefined => {
  const model = recordOf(raw)
  if (model === undefined || typeof model["id"] !== "string" || model["id"].trim().length === 0) return undefined
  const limit = recordOf(model["limit"])
  const modalities = recordOf(model["modalities"])
  const contextWindowTokens = positiveInteger(limit?.["context"])
  const maxOutputTokens = positiveInteger(limit?.["output"])
  const pricing = pricingOf(model["cost"])
  const inputModalities = strings(modalities?.["input"])
  const outputModalities = strings(modalities?.["output"])
  const name = typeof model["name"] === "string" && model["name"].trim().length > 0 ? model["name"].trim() : undefined
  return {
    id: model["id"].trim(),
    ...(name === undefined ? {} : { name }),
    metadata: {
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens: metadataValue(contextWindowTokens, source) }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: metadataValue(maxOutputTokens, source) }),
      ...(pricing === undefined ? {} : { pricing: metadataValue(pricing, source) }),
      ...(typeof model["tool_call"] === "boolean" ? { toolCall: metadataValue(model["tool_call"], source) } : {}),
      ...(typeof model["structured_output"] === "boolean" ? { structuredOutput: metadataValue(model["structured_output"], source) } : {}),
      ...(inputModalities.length === 0 ? {} : { inputModalities: metadataValue(inputModalities, source) }),
      ...(outputModalities.length === 0 ? {} : { outputModalities: metadataValue(outputModalities, source) })
    }
  }
}

// modelsDevCatalogOf parses the provider-indexed models.dev API response.
export const modelsDevCatalogOf = (raw: unknown, revision: string): ReadonlyArray<DiscoveredProvider> => {
  const catalog = recordOf(raw)
  if (catalog === undefined) return []
  const source: ModelMetadataSource = { kind: "managed", catalog: "models.dev", revision }
  const providers: DiscoveredProvider[] = []
  for (const [key, value] of Object.entries(catalog)) {
    const provider = recordOf(value)
    if (provider === undefined) continue
    const id = typeof provider["id"] === "string" && provider["id"].trim().length > 0 ? provider["id"].trim() : key
    const models = recordOf(provider["models"])
    providers.push({
      id,
      name: typeof provider["name"] === "string" && provider["name"].trim().length > 0 ? provider["name"].trim() : id,
      ...(typeof provider["api"] === "string" && provider["api"].trim().length > 0 ? { api: provider["api"].trim() } : {}),
      ...(typeof provider["npm"] === "string" && provider["npm"].trim().length > 0 ? { npm: provider["npm"].trim() } : {}),
      env: strings(provider["env"]),
      models: models === undefined
        ? []
        : Object.values(models).flatMap((model) => {
            const parsed = modelsDevModelOf(model, source)
            return parsed === undefined ? [] : [parsed]
          }).sort((left, right) => left.id.localeCompare(right.id))
    })
  }
  return providers.sort((left, right) => left.id.localeCompare(right.id))
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
