import { Context, Effect, Layer, Schema } from "effect"
import {
  ModelCatalog as ModelCatalogSchema,
  type ModelCatalog
} from "@clavia/tardigrade-client/contract"
import { modelsDevCatalogOf, type ModelMetadata } from "@clavia/tardigrade-model/metadata"

import { ServerConfig } from "./config"
import { ModelCatalogRepository } from "./catalog-store"

export interface ModelCatalogState {
  readonly snapshot?: ModelCatalog
  readonly refreshError?: string
  readonly cacheError?: string
}

// ModelCatalogStore holds the snapshot resolved once when this server starts.
export class ModelCatalogStore extends Context.Service<
  ModelCatalogStore,
  ModelCatalogState
>()("tardigrade/server/ModelCatalogStore") {}

export const MODEL_CATALOG_LOAD_POLICIES = ["cache-first", "refresh"] as const
export type ModelCatalogLoadPolicy = typeof MODEL_CATALOG_LOAD_POLICIES[number]

// DEFAULT_SERVER_MODEL_CATALOG_LOAD_POLICY refreshes once when a server process starts.
export const DEFAULT_SERVER_MODEL_CATALOG_LOAD_POLICY: ModelCatalogLoadPolicy = "refresh"

export interface ModelCatalogLoadOptions {
  readonly sourceUrl: string
  readonly timeoutMillis: number
  readonly policy: ModelCatalogLoadPolicy
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

const sha256Of = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const refreshed = async (options: ModelCatalogLoadOptions): Promise<ModelCatalog> => {
  const response = await (options.fetch ?? globalThis.fetch)(options.sourceUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMillis)
  })
  if (!response.ok) throw new Error(`model catalog returned ${response.status}`)
  const text = await response.text()
  const revision = response.headers.get("etag") ?? response.headers.get("last-modified") ??
    await sha256Of(text)
  return modelCatalogOf(JSON.parse(text) as unknown, revision, (options.now ?? Date.now)())
}

const cacheRead = (sourceUrl: string) => Effect.flatMap(ModelCatalogRepository, (repository) =>
  repository.read(sourceUrl).pipe(Effect.match({
    onFailure: (error) => ({ cacheError: error.message }),
    onSuccess: (snapshot) => snapshot === undefined ? {} : { snapshot }
  })))

// loadModelCatalog resolves one in-memory snapshot according to the stated source policy.
export const loadModelCatalog = (options: ModelCatalogLoadOptions): Effect.Effect<ModelCatalogState, never, ModelCatalogRepository> =>
  Effect.gen(function*() {
    let cached: ModelCatalogState | undefined
    if (options.policy === "cache-first") {
      cached = yield* cacheRead(options.sourceUrl)
      if (cached.snapshot !== undefined) return cached
    }

    const refreshedState = yield* Effect.tryPromise({
      try: () => refreshed(options),
      catch: messageOf
    }).pipe(Effect.match({
      onFailure: (refreshError) => ({ _tag: "Failure" as const, refreshError }),
      onSuccess: (snapshot) => ({ _tag: "Success" as const, snapshot })
    }))

    if (refreshedState._tag === "Success") {
      const repository = yield* ModelCatalogRepository
      const cacheError = yield* repository.write(options.sourceUrl, refreshedState.snapshot).pipe(Effect.match({
        onFailure: (error) => error.message,
        onSuccess: () => undefined
      }))
      return {
        snapshot: refreshedState.snapshot,
        ...(cached?.cacheError === undefined && cacheError === undefined
          ? {}
          : { cacheError: [cached?.cacheError, cacheError].filter((message) => message !== undefined).join("; ") })
      }
    }

    cached ??= yield* cacheRead(options.sourceUrl)
    return {
      ...(cached.snapshot === undefined ? {} : { snapshot: cached.snapshot }),
      refreshError: refreshedState.refreshError,
      ...(cached.cacheError === undefined ? {} : { cacheError: cached.cacheError })
    }
  })

// layerModelCatalog refreshes the configured source once for the lifetime of the server process.
export const layerModelCatalog = (
  options: Partial<Pick<ModelCatalogLoadOptions, "fetch" | "now" | "policy">> = {}
): Layer.Layer<ModelCatalogStore, never, ServerConfig | ModelCatalogRepository> =>
  Layer.effect(
    ModelCatalogStore,
    Effect.flatMap(ServerConfig, (config) =>
      Effect.tap(
        loadModelCatalog({
          sourceUrl: config.catalog.sourceUrl,
          timeoutMillis: config.catalog.timeoutMillis,
          policy: options.policy ?? DEFAULT_SERVER_MODEL_CATALOG_LOAD_POLICY,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.now === undefined ? {} : { now: options.now })
        }),
        (state) => Effect.all([
          state.refreshError === undefined ? Effect.void : Effect.logWarning(`model catalog refresh failed: ${state.refreshError}`),
          state.cacheError === undefined ? Effect.void : Effect.logWarning(`model catalog cache failed: ${state.cacheError}`)
        ], { discard: true })
      ))
  )

export const layerModelCatalogValue = (snapshot: ModelCatalog): Layer.Layer<ModelCatalogStore> =>
  Layer.succeed(ModelCatalogStore)({ snapshot })

export const layerModelCatalogUnavailable: Layer.Layer<ModelCatalogStore> =
  Layer.succeed(ModelCatalogStore)({ refreshError: "no validated model catalog is available" })
