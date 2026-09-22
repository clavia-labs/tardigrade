import { canonicalModelConfig, type ModelConfig } from "../config"
import { Context, Effect, Layer, Schema } from "effect"
import {
  ModelCatalog as ModelCatalogSchema,
  type ModelCatalog
} from "@clavia/tardigrade-model/catalog/schema"
import { modelsDevCatalogOf, type ModelMetadata } from "./metadata"

import {
  type ModelRegistryCache,
  modelCatalogScopeOf,
  type ModelCatalogScope
} from "./repository"

// modelCatalogWithConfiguredModels merges authored metadata before model selection (custom.test.ts).
export const modelCatalogWithConfiguredModels = async (config: ModelConfig, snapshot?: ModelCatalog): Promise<ModelCatalog | undefined> => {
  const providers = new Map((snapshot?.providers ?? []).map((provider) => [provider.id, provider]))
  let changed = false
  for (const [id, connection] of Object.entries(config.providers)) {
    const original = providers.get(id)
    const models = new Map((original?.models ?? []).map((model) => [model.id, model]))
    for (const [model_id, settings] of Object.entries(connection.models ?? {})) {
      if (settings.metadata === undefined) continue
      const existing = models.get(model_id)
      const metadata = { ...existing?.metadata, ...settings.metadata }
      if (metadata.contextWindowTokens === undefined) continue
      models.set(model_id, { ...existing, id: model_id, metadata })
      changed = true
    }
    if (models.size > 0) providers.set(id, {
      ...(original ?? { id, name: id, api: connection.baseUrl, env: connection.env }), models: [...models.values()]
    })
  }
  if (!changed) return snapshot
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalModelConfig(config)))
  const revision = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return {
    source: snapshot === undefined ? "custom" : "mixed",
    revision: `${snapshot?.revision ?? "custom"}:${revision}`,
    refreshedAt: snapshot?.refreshedAt ?? 0,
    status: snapshot?.status ?? "cached",
    providers: [...providers.values()]
  }
}

export interface ModelCatalogState {
  readonly snapshot?: ModelCatalog
  readonly refreshError?: string
  readonly cacheError?: string
}

export const MODEL_CATALOG_LOAD_POLICIES = ["cache-first", "refresh"] as const
export type ModelCatalogLoadPolicy = typeof MODEL_CATALOG_LOAD_POLICIES[number]


export interface ModelCatalogLoadOptions {
  readonly sourceUrl: string
  readonly timeoutMillis: number
  readonly policy: ModelCatalogLoadPolicy
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

const cacheRead = (repository: ModelRegistryCache, sourceUrl: string, scope: ModelCatalogScope | undefined) =>
  (scope === undefined ? repository.read(sourceUrl) : repository.readScope(sourceUrl, scope)).pipe(Effect.match({
    onFailure: (error) => ({ cacheError: error.message }),
    onSuccess: (snapshot) => snapshot === undefined ? {} : { snapshot }
  }))

const load = (repository: ModelRegistryCache, options: ModelCatalogLoadOptions): Effect.Effect<ModelCatalogState> =>
  Effect.gen(function*() {
    let cached: ModelCatalogState | undefined
    if (options.policy === "cache-first") {
      cached = yield* cacheRead(repository, options.sourceUrl, options.scope)
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

    cached ??= yield* cacheRead(repository, options.sourceUrl, options.scope)
    return {
      ...(cached.snapshot === undefined ? {} : { snapshot: cached.snapshot }),
      refreshError: refreshedState.refreshError,
      ...(cached.cacheError === undefined ? {} : { cacheError: cached.cacheError })
    }
  })

// ModelRegistry loads external metadata with an optional persistent cache (apps/server/src/catalog.test.ts).
export class ModelRegistry extends Context.Service<ModelRegistry, {
  readonly load: (options: ModelCatalogLoadOptions) => Effect.Effect<ModelCatalogState>
}>()("tardigrade/model/ModelRegistry") {}

export const modelRegistry = (cache: ModelRegistryCache): typeof ModelRegistry.Service => ({
  load: options => load(cache, options)
})

export const loadModelCatalog = (options: ModelCatalogLoadOptions) =>
  Effect.flatMap(ModelRegistry, registry => registry.load(options))

export const layerMemoryModelRegistry = (initial: ReadonlyArray<readonly [string, ModelCatalog]> = []) => {
  const snapshots = new Map(initial)
  const read = (source: string) => Effect.succeed(snapshots.get(source))
  return Layer.succeed(ModelRegistry, modelRegistry({
    read: source => Effect.map(read(source), snapshot => snapshot === undefined ? undefined : { ...snapshot, status: "cached" }),
    readScope: (source, scope) => Effect.map(read(source), snapshot => snapshot === undefined ? undefined : modelCatalogScopeOf({ ...snapshot, status: "cached" }, scope)),
    write: (source, snapshot) => Effect.sync(() => { snapshots.set(source, snapshot) })
  }))
}
