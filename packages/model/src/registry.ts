import { sha256Of } from "./digest"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { ModelCatalog as ModelCatalogSchema, type ModelCatalog } from "./catalog/schema"
import { modelsDevCatalogOf, type ModelMetadata } from "./catalog/metadata"
import { ModelCatalogRepository, modelCatalogScopeOf, type ModelCatalogScope } from "./catalog/repository"
import type { ModelCatalogState } from "./catalog/index"

export const MODEL_REGISTRY_LOAD_POLICIES = ["cache-first", "refresh"] as const
export type ModelRegistryLoadPolicy = typeof MODEL_REGISTRY_LOAD_POLICIES[number]


export interface ModelRegistryLoadOptions {
  readonly sourceUrl: string
  readonly timeoutMillis: number
  readonly policy: ModelRegistryLoadPolicy
  readonly scope?: ModelCatalogScope
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const pricingOf = (metadata: ModelMetadata) => {
  const pricing = metadata.pricing
  if (pricing === undefined) return undefined
  for (const [name, rate] of Object.entries(pricing)) {
    if (!Number.isFinite(rate) || rate < 0) throw new Error(`model catalog pricing ${name} must be a non-negative number`)
  }
  return pricing
}

const metadataOf = (metadata: ModelMetadata): ModelCatalog["providers"][number]["models"][number]["metadata"] => {
  const pricing = pricingOf(metadata)
  return {
    ...(metadata.contextWindowTokens === undefined ? {} : { contextWindowTokens: metadata.contextWindowTokens }),
    ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
    ...(pricing === undefined ? {} : { pricing }),
    ...(metadata.toolCall === undefined ? {} : { toolCall: metadata.toolCall }),
    ...(metadata.structuredOutput === undefined ? {} : { structuredOutput: metadata.structuredOutput }),
    ...(metadata.inputModalities === undefined ? {} : { inputModalities: metadata.inputModalities }),
    ...(metadata.outputModalities === undefined ? {} : { outputModalities: metadata.outputModalities })
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
  const discovered = modelsDevCatalogOf(raw)
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

const refreshed = async (options: ModelRegistryLoadOptions): Promise<ModelCatalog> => {
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

const cacheRead = (sourceUrl: string, scope: ModelCatalogScope | undefined) => Effect.flatMap(ModelCatalogRepository, (repository) =>
  (scope === undefined ? repository.read(sourceUrl) : repository.readScope(sourceUrl, scope)).pipe(Effect.match({
    onFailure: (error) => ({ cacheError: error.message }),
    onSuccess: (snapshot) => snapshot === undefined ? {} : { snapshot }
  })))

// loadModelRegistry resolves one in-memory snapshot according to the stated source policy.
export const loadModelRegistry = (options: ModelRegistryLoadOptions): Effect.Effect<ModelCatalogState, never, ModelCatalogRepository> =>
  Effect.gen(function*() {
    let cached: ModelCatalogState | undefined
    if (options.policy === "cache-first") {
      cached = yield* cacheRead(options.sourceUrl, options.scope)
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
        snapshot: options.scope === undefined
          ? refreshedState.snapshot
          : modelCatalogScopeOf(refreshedState.snapshot, options.scope),
        ...(cached?.cacheError === undefined && cacheError === undefined
          ? {}
          : { cacheError: [cached?.cacheError, cacheError].filter((message) => message !== undefined).join("; ") })
      }
    }

    cached ??= yield* cacheRead(options.sourceUrl, options.scope)
    return {
      ...(cached.snapshot === undefined ? {} : { snapshot: cached.snapshot }),
      refreshError: refreshedState.refreshError,
      ...(cached.cacheError === undefined ? {} : { cacheError: cached.cacheError })
    }
  })


export class ModelRegistryError extends Data.TaggedError("ModelRegistryError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ModelRegistryRequest {
  readonly source?: string
  readonly policy: ModelRegistryLoadPolicy
  readonly scope?: ModelCatalogScope
}

// ModelRegistry supplies definitions for discovery and lock resolution (resolution.test.ts).
export class ModelRegistry extends Context.Service<ModelRegistry, {
  readonly source?: string
  readonly load: (request: ModelRegistryRequest) => Effect.Effect<ModelCatalog, ModelRegistryError>
}>()("tardigrade/model/ModelRegistry") {}

// layerHttpModelRegistry loads HTTP definitions through the supplied cache repository (registry.test.ts).
export const layerHttpModelRegistry = (
  options: Omit<ModelRegistryLoadOptions, "policy" | "scope">
): Layer.Layer<ModelRegistry, never, ModelCatalogRepository> => Layer.effect(ModelRegistry)(Effect.gen(function*() {
  const repository = yield* ModelCatalogRepository
  return {
    source: options.sourceUrl,
    load: (request) => loadModelRegistry({ ...options, ...request, sourceUrl: request.source ?? options.sourceUrl }).pipe(
      Effect.provideService(ModelCatalogRepository, repository),
      Effect.flatMap((state) => state.snapshot === undefined
        ? Effect.fail(new ModelRegistryError({ message: state.refreshError ?? state.cacheError ?? "model registry is unavailable" }))
        : Effect.succeed(state.snapshot))
    )
  }
}))
