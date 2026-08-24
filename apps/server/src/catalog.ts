import { Context, Effect, Layer, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  ModelCatalog as ModelCatalogSchema,
  type ModelCatalog
} from "@clavia/tardigrade-client/contract"
import { modelsDevCatalogOf, type ModelMetadata } from "@clavia/tardigrade-model/metadata"

import { ServerConfig, type ModelCatalogConfig } from "./config"

export interface ModelCatalogState {
  readonly snapshot?: ModelCatalog
  readonly refreshError?: string
}

// ModelCatalogStore holds the snapshot resolved once when this server starts.
export class ModelCatalogStore extends Context.Service<
  ModelCatalogStore,
  ModelCatalogState
>()("tardigrade/server/ModelCatalogStore") {}

export interface ModelCatalogLoadOptions extends ModelCatalogConfig {
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const pricingOf = (metadata: ModelMetadata) => {
  const pricing = metadata.pricing?.value
  if (pricing === undefined) return undefined
  for (const [name, rate] of Object.entries(pricing)) {
    if (!Number.isFinite(rate) || rate < 0) throw new Error(`model catalog pricing ${name} must be a non-negative number`)
  }
  return pricing
}

const metadataOf = (metadata: ModelMetadata): ModelCatalog["providers"][number]["models"][number]["metadata"] => {
  const pricing = pricingOf(metadata)
  return {
    ...(metadata.contextWindowTokens === undefined ? {} : { contextWindowTokens: metadata.contextWindowTokens.value }),
    ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens.value }),
    ...(pricing === undefined ? {} : { pricing }),
    ...(metadata.toolCall === undefined ? {} : { toolCall: metadata.toolCall.value }),
    ...(metadata.structuredOutput === undefined ? {} : { structuredOutput: metadata.structuredOutput.value }),
    ...(metadata.inputModalities === undefined ? {} : { inputModalities: metadata.inputModalities.value }),
    ...(metadata.outputModalities === undefined ? {} : { outputModalities: metadata.outputModalities.value })
  }
}

// modelCatalogOf validates one models.dev document and projects the public response owned by this API.
export const modelCatalogOf = (
  raw: unknown,
  revision: string,
  refreshedAt: number
): ModelCatalog => {
  const source = recordOf(raw)
  if (source === undefined) throw new Error("model catalog must be a provider object")
  let sourceModels = 0
  for (const [providerId, rawProvider] of Object.entries(source)) {
    const provider = recordOf(rawProvider)
    if (provider === undefined) throw new Error(`model catalog provider ${JSON.stringify(providerId)} must be an object`)
    const models = recordOf(provider["models"])
    if (models === undefined) throw new Error(`model catalog provider ${JSON.stringify(providerId)} must declare models`)
    sourceModels += Object.keys(models).length
  }
  const discovered = modelsDevCatalogOf(raw, revision)
  const discoveredModels = discovered.reduce((total, provider) => total + provider.models.length, 0)
  if (discovered.length !== Object.keys(source).length || discoveredModels !== sourceModels) {
    throw new Error("model catalog contains a provider or model that failed validation")
  }
  const providers = discovered.map((provider) => ({
    id: provider.id,
    name: provider.name,
    ...(provider.api === undefined ? {} : { api: provider.api }),
    ...(provider.npm === undefined ? {} : { npm: provider.npm }),
    env: provider.env,
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      metadata: metadataOf(model.metadata)
    }))
  }))
  if (providers.every((provider) => provider.models.length === 0)) {
    throw new Error("model catalog contains no providers with models")
  }
  return Schema.decodeSync(ModelCatalogSchema)({
    source: "models.dev",
    revision,
    refreshedAt,
    status: "fresh",
    providers
  })
}

const cachedAt = async (options: ModelCatalogLoadOptions): Promise<ModelCatalog | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(options.cachePath, "utf8")) as unknown
    const stored = recordOf(parsed)
    if (stored?.["schema"] !== 1 || stored["sourceKey"] !== sourceKeyOf(options.sourceUrl)) return undefined
    const snapshot = Schema.decodeUnknownSync(ModelCatalogSchema)(stored["snapshot"])
    if (snapshot.revision.trim().length === 0 || snapshot.providers.every((provider) => provider.models.length === 0)) {
      return undefined
    }
    return { ...snapshot, status: "cached" }
  } catch {
    return undefined
  }
}

const sourceKeyOf = (sourceUrl: string): string =>
  `sha256:${createHash("sha256").update(sourceUrl).digest("hex")}`

const writeAtomically = async (path: string, sourceUrl: string, snapshot: ModelCatalog): Promise<void> => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, `${JSON.stringify({ schema: 1, sourceKey: sourceKeyOf(sourceUrl), snapshot })}\n`, {
      encoding: "utf8",
      mode: 0o644
    })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

const refreshed = async (options: ModelCatalogLoadOptions): Promise<ModelCatalog> => {
  const response = await (options.fetch ?? globalThis.fetch)(options.sourceUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMillis)
  })
  if (!response.ok) throw new Error(`model catalog returned ${response.status}`)
  const text = await response.text()
  const revision = response.headers.get("etag") ?? response.headers.get("last-modified") ??
    `sha256:${createHash("sha256").update(text).digest("hex")}`
  const snapshot = modelCatalogOf(JSON.parse(text) as unknown, revision, (options.now ?? Date.now)())
  await writeAtomically(options.cachePath, options.sourceUrl, snapshot)
  return snapshot
}

// loadModelCatalog refreshes the source and falls back to the last validated snapshot at the same source URL.
export const loadModelCatalog = async (options: ModelCatalogLoadOptions): Promise<ModelCatalogState> => {
  try {
    return { snapshot: await refreshed(options) }
  } catch (error) {
    const cached = await cachedAt(options)
    return {
      ...(cached === undefined ? {} : { snapshot: cached }),
      refreshError: messageOf(error)
    }
  }
}

// layerModelCatalog refreshes the configured source once for the lifetime of the server process.
export const layerModelCatalog = (
  options: Pick<ModelCatalogLoadOptions, "fetch" | "now"> = {}
): Layer.Layer<ModelCatalogStore, never, ServerConfig> =>
  Layer.effect(
    ModelCatalogStore,
    Effect.flatMap(ServerConfig, (config) =>
      Effect.tap(
        Effect.promise(() => loadModelCatalog({ ...config.catalog, ...options })),
        (state) => state.refreshError === undefined
          ? Effect.void
          : Effect.logWarning(`model catalog refresh failed: ${state.refreshError}`)
      ))
  )

export const layerModelCatalogValue = (snapshot: ModelCatalog): Layer.Layer<ModelCatalogStore> =>
  Layer.succeed(ModelCatalogStore)({ snapshot })

export const layerModelCatalogUnavailable: Layer.Layer<ModelCatalogStore> =
  Layer.succeed(ModelCatalogStore)({ refreshError: "no validated model catalog is available" })
