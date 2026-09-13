import { Data, Effect, Option } from "effect"
import type { ModelCatalog } from "./catalog/schema"
import { modelConfigOf, type ModelConfig } from "./config"
import { MODEL_LOCK_SCHEMA, modelLockOf, modelConfigForPolicy, type ModelLockData } from "./lock"
import { ModelRegistry, ModelRegistryError } from "./registry"

export class ModelLockResolutionError extends Data.TaggedError("ModelLockResolutionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
const resolutionErrorOf = (cause: unknown) => new ModelLockResolutionError({
  message: cause instanceof Error ? cause.message : String(cause), cause
})

export interface ModelLockResolutionOptions {
  readonly previous?: ModelLockData
  readonly refresh?: boolean
  readonly source?: string
}
const coordinate = (provider: string, model: string) => JSON.stringify([provider, model])

// resolveModelLock imports missing definitions and refreshes sourced metadata only when requested (resolution.test.ts).
export const resolveModelLock = (input: ModelConfig, options: ModelLockResolutionOptions = {}): Effect.Effect<ModelLockData, ModelLockResolutionError | ModelRegistryError> => Effect.gen(function*() {
  const config = yield* Effect.try({ try: () => modelConfigOf(input), catch: resolutionErrorOf })
  const previous = yield* Effect.try({ try: () => options.previous === undefined ? undefined : modelLockOf(options.previous), catch: resolutionErrorOf })
  const models = new Map((previous?.models ?? []).map((model) => [coordinate(model.provider, model.model_id), model]))
  const supplied = yield* Effect.serviceOption(ModelRegistry)
  const load = (source?: string) => Option.isNone(supplied)
    ? Effect.fail(new ModelRegistryError({ message: "model definitions are missing; provide a ModelRegistry service or complete custom metadata" }))
    : supplied.value.load({ policy: "refresh", ...(source === undefined ? {} : { source }) })
  const providers = {
    ...previous?.providers,
    ...Object.fromEntries(Object.entries(config.providers).map(([id, connection]) => {
      const { models: _models, ...provider } = connection
      return [id, provider]
    }))
  }
  const pending = Object.entries(config.providers).flatMap(([provider, connection]) =>
    Object.entries(connection.models ?? {}).map(([model_id, settings]) => ({ provider, model_id, settings })))
  for (const { provider, model_id, settings } of pending) {
    if (settings.metadata?.contextWindowTokens === undefined) continue
    const old = models.get(coordinate(provider, model_id))
    models.set(coordinate(provider, model_id), {
      ...old, provider, model_id, ...settings.metadata, contextWindowTokens: settings.metadata.contextWindowTokens,
      ...(settings.options === undefined ? {} : { options: settings.options })
    })
  }
  const required = [
    ...(config.default === undefined ? [] : [config.default]),
    ...(config.allow === "*" ? [] : config.allow.flatMap((entry) => entry.model_ids === "*" ? [] : entry.model_ids.map((model_id) => ({ provider: entry.provider, model_id }))))
  ]
  const needsRegistry = Object.keys(config.providers).some((id) => ![...models.values()].some((model) => model.provider === id)) ||
    required.some((ref) => !models.has(coordinate(ref.provider, ref.model_id))) ||
    pending.some((entry) => !models.has(coordinate(entry.provider, entry.model_id)))
  if (needsRegistry) {
    const registry = yield* load()
    const source = Option.isSome(supplied) ? supplied.value.source : undefined
    for (const provider of registry.providers) {
      if (providers[provider.id] === undefined) continue
      for (const model of provider.models) {
        if (model.metadata.contextWindowTokens === undefined || models.has(coordinate(provider.id, model.id))) continue
        models.set(coordinate(provider.id, model.id), {
          provider: provider.id, model_id: model.id, ...model.metadata, contextWindowTokens: model.metadata.contextWindowTokens,
          ...(source === undefined ? {} : { source })
        })
      }
    }
  }
  for (const { provider, model_id, settings } of pending) {
    const key = coordinate(provider, model_id)
    const model = models.get(key)
    if (model === undefined) return yield* resolutionErrorOf(new Error(`model ${provider}/${model_id} must declare contextWindowTokens`))
    models.set(key, { ...model, ...settings.metadata, ...(settings.options === undefined ? {} : { options: settings.options }) })
  }
  if (options.refresh === true) {
    const snapshots = new Map<string, ModelCatalog>()
    for (const [key, model] of models) {
      if (model.source === undefined) continue
      const source = options.source ?? model.source
      let snapshot = snapshots.get(source)
      if (snapshot === undefined) { snapshot = yield* load(source); snapshots.set(source, snapshot) }
      const found = snapshot.providers.find((provider) => provider.id === model.provider)?.models.find((entry) => entry.id === model.model_id)
      if (found?.metadata.contextWindowTokens === undefined) return yield* resolutionErrorOf(new Error(`source has no complete definition for ${model.provider}/${model.model_id}; saved lock was not changed`))
      models.set(key, {
        provider: model.provider, model_id: model.model_id, ...found.metadata, contextWindowTokens: found.metadata.contextWindowTokens,
        source, ...(model.options === undefined ? {} : { options: model.options })
      })
    }
  }
  return yield* Effect.try({
    try: () => {
      const lock = modelLockOf({ schema: MODEL_LOCK_SCHEMA, providers, models: [...models.values()] })
      modelConfigForPolicy(config, lock)
      return lock
    },
    catch: resolutionErrorOf
  })
})
