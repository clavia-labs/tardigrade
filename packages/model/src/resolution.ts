import { sha256Of } from "./digest"
import { Data, Effect, Option } from "effect"
import type { ModelCatalog } from "./catalog/schema"
import { modelCatalogScopeOf } from "./catalog/repository"
import { modelConfigOf, type ModelConfig } from "./config"
import { MODEL_LOCK_SCHEMA, modelLockOf, modelConfigDigest, modelCatalogForConfig, type ModelLock } from "./lock"
import { ModelRegistry, ModelRegistryError } from "./registry"

export class ModelLockResolutionError extends Data.TaggedError("ModelLockResolutionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const resolutionErrorOf = (cause: unknown) => new ModelLockResolutionError({
  message: cause instanceof Error ? cause.message : String(cause), cause
})

// resolveModelLock uses an optional registry to fill missing definitions (resolution.test.ts).
export const resolveModelLock = (input: ModelConfig): Effect.Effect<ModelLock, ModelLockResolutionError | ModelRegistryError> => Effect.gen(function*() {
  const config = yield* Effect.try({ try: () => modelConfigOf(input), catch: resolutionErrorOf })
  const configured = Object.entries(config.providers)
  const selfContained = configured.every(([id, provider]) => {
    const entries = Object.values(provider.models ?? {})
    const required = [
      ...(config.default?.provider === id ? [config.default.model_id] : []),
      ...(config.allow === "*" ? [] : config.allow.flatMap((selection) =>
        selection.provider === id && selection.model_ids !== "*" ? selection.model_ids : []))
    ]
    return entries.length > 0 && entries.every((entry) => entry.metadata?.contextWindowTokens !== undefined) &&
      required.every((model) => provider.models?.[model]?.metadata?.contextWindowTokens !== undefined)
  })
  let registry: ModelCatalog | undefined
  if (!selfContained) {
    const service = yield* Effect.serviceOption(ModelRegistry)
    if (Option.isNone(service)) return yield* new ModelRegistryError({ message: "model definitions are missing; provide a ModelRegistry service or complete custom metadata" })
    registry = yield* service.value.load({ policy: "refresh" })
  }
  return yield* Effect.tryPromise({
    try: async () => {
      let custom = false
      const providers = configured.map(([id, connection]) => {
        const discovered = registry?.providers.find((provider) => provider.id === id)
        const models = new Map((discovered?.models ?? []).map((model) => [model.id, model]))
        for (const [modelId, settings] of Object.entries(connection.models ?? {})) {
          if (settings.metadata === undefined) continue
          custom = true
          const previous = models.get(modelId)
          const metadata = { ...previous?.metadata, ...settings.metadata }
          if (metadata.contextWindowTokens === undefined) throw new Error(`model ${id}/${modelId} must declare contextWindowTokens`)
          models.set(modelId, { ...previous, id: modelId, metadata })
        }
        return { ...discovered, id, name: discovered?.name ?? id, env: connection.env, models: [...models.values()] }
      })
      const catalog = modelCatalogScopeOf({
        source: custom ? registry === undefined ? "custom" : "mixed" : registry?.source ?? "custom",
        revision: registry?.revision ?? "custom",
        refreshedAt: registry?.refreshedAt ?? 0,
        status: registry?.status ?? "cached",
        providers
      }, { providers: configured.map(([id]) => id), policy: config })
      const resolved = custom ? {
        ...catalog,
        revision: await sha256Of(JSON.stringify(catalog))
      } : catalog
      const lock = modelLockOf({ schema: MODEL_LOCK_SCHEMA, configDigest: await modelConfigDigest(config), catalog: resolved })
      await modelCatalogForConfig(config, lock)
      return lock
    },
    catch: resolutionErrorOf
  })
})
