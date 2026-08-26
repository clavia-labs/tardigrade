import type { ModelPricing } from "tardie/inference/usage"

export const DEFAULT_MODEL_CATALOG_URL = "https://models.dev/api.json"

export interface ModelMetadata {
  readonly contextWindowTokens?: number
  readonly maxOutputTokens?: number
  readonly pricing?: ModelPricing
  readonly toolCall?: boolean
  readonly structuredOutput?: boolean
  readonly inputModalities?: ReadonlyArray<string>
  readonly outputModalities?: ReadonlyArray<string>
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

export const modelsDevModelOf = (raw: unknown): DiscoveredModel | undefined => {
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
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(pricing === undefined ? {} : { pricing }),
      ...(typeof model["tool_call"] === "boolean" ? { toolCall: model["tool_call"] } : {}),
      ...(typeof model["structured_output"] === "boolean" ? { structuredOutput: model["structured_output"] } : {}),
      ...(inputModalities.length === 0 ? {} : { inputModalities }),
      ...(outputModalities.length === 0 ? {} : { outputModalities })
    }
  }
}

// modelsDevCatalogOf parses the provider-indexed models.dev API response.
export const modelsDevCatalogOf = (raw: unknown): ReadonlyArray<DiscoveredProvider> => {
  const catalog = recordOf(raw)
  if (catalog === undefined) return []
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
            const parsed = modelsDevModelOf(model)
            return parsed === undefined ? [] : [parsed]
          }).sort((left, right) => left.id.localeCompare(right.id))
    })
  }
  return providers.sort((left, right) => left.id.localeCompare(right.id))
}
