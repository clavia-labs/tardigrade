import { Context, Data, Effect, Layer, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { ModelCatalogMetadata, type ModelCatalog } from "./catalog/schema"
import { modelProvidersOf, modelSettingsOf, type ModelConfig } from "./config"
import { modelPolicyOf, type ModelPolicy } from "./access"
import { modelCatalogScopeOf } from "./catalog/repository"
import { MODEL_PROTOCOLS } from "./providers/directory"
import { sha256Of } from "./digest"

export const MODEL_LOCK_SCHEMA = 2
export const MODEL_LOCK_FILE = "models.lock.json"

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const Provider = Schema.Struct({
  protocol: Schema.Literals(MODEL_PROTOCOLS),
  baseUrl: Schema.NonEmptyString,
  env: Schema.Array(Schema.NonEmptyString),
  region: Schema.optionalKey(Schema.NonEmptyString)
})
const LockedModel = Schema.Struct({
  ...ModelCatalogMetadata.fields,
  provider: Schema.NonEmptyString,
  model_id: Schema.NonEmptyString,
  contextWindowTokens: PositiveInteger,
  options: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  source: Schema.optionalKey(Schema.NonEmptyString)
})
const LockSchema = Schema.Struct({
  schema: Schema.Literal(MODEL_LOCK_SCHEMA),
  providers: Schema.Record(Schema.NonEmptyString, Provider),
  models: Schema.Array(LockedModel)
})

export type ModelLockData = typeof LockSchema.Type
export type ModelScope = ModelLockData

export class ModelLockError extends Data.TaggedError("ModelLockError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const modelLockErrorOf = (cause: unknown): ModelLockError => new ModelLockError({
  message: cause instanceof Error ? cause.message : String(cause), cause
})

// ModelLock supplies validated runtime definitions independently of their loader (lock.test.ts).
export class ModelLock extends Context.Service<ModelLock, ModelLockData>()("tardigrade/model/ModelLock") {}

export const emptyModelLock = (): ModelLockData => ({ schema: MODEL_LOCK_SCHEMA, providers: {}, models: [] })

// modelLockOf validates complete definitions and unique provider/model coordinates (lock.test.ts).
export const modelLockOf = (value: unknown): ModelLockData => {
  const lock = Schema.decodeUnknownSync(LockSchema, { onExcessProperty: "error" })(value)
  modelProvidersOf(lock.providers)
  const coordinates = new Set<string>()
  for (const model of lock.models) {
    const key = JSON.stringify([model.provider, model.model_id])
    if (coordinates.has(key)) throw new Error(`duplicate model ${model.provider}/${model.model_id}`)
    coordinates.add(key)
    const provider = lock.providers[model.provider]
    if (provider === undefined) throw new Error(`model ${model.provider}/${model.model_id} references an absent provider`)
    modelSettingsOf(provider.protocol, { [model.model_id]: { options: model.options } })
    if (model.source !== undefined && !["https:", "http:"].includes(new URL(model.source).protocol)) {
      throw new Error(`model ${model.provider}/${model.model_id} source must be an HTTP(S) registry URL`)
    }
  }
  return lock
}

// layerModelLock validates an in-memory definition without reading a file (lock.test.ts).
export const layerModelLock = (value: unknown): Layer.Layer<ModelLock, ModelLockError> =>
  Layer.effect(ModelLock)(Effect.try({ try: () => modelLockOf(value), catch: modelLockErrorOf }))

// layerFileModelLock reads the same schema through an injected filesystem (lock.test.ts).
export const layerFileModelLock = (path: string): Layer.Layer<ModelLock, ModelLockError, FileSystem> =>
  Layer.effect(ModelLock)(Effect.gen(function*() {
    const raw = yield* (yield* FileSystem).readFileString(path).pipe(Effect.mapError(modelLockErrorOf))
    return yield* Effect.try({ try: () => modelLockOf(JSON.parse(raw)), catch: modelLockErrorOf })
  }))

// lockedProvidersOf projects lock entries into the inference binding's connection shape (lock.test.ts).
export const lockedProvidersOf = (lock: ModelLockData): ModelConfig["providers"] =>
  Object.fromEntries(Object.entries(lock.providers).map(([id, connection]) => [id, {
    ...connection,
    models: Object.fromEntries(lock.models.filter((model) => model.provider === id).map((model) => {
      const { provider: _provider, model_id, source: _source, options, ...metadata } = model
      return [model_id, { metadata, ...(options === undefined ? {} : { options }) }]
    }))
  }]))

// modelConfigForPolicy checks that all explicit policy references exist in the lock (lock.test.ts).
export const modelConfigForPolicy = (policy: ModelPolicy, lock: ModelLockData): ModelConfig => {
  const selected = modelPolicyOf({ allow: policy.allow, ...(policy.default === undefined ? {} : { default: policy.default }) })
  const required = [
    ...(selected.default === undefined ? [] : [selected.default]),
    ...(selected.allow === "*" ? [] : selected.allow.flatMap((entry) => {
      if (!lock.models.some((model) => model.provider === entry.provider)) throw new Error(`allowed provider ${entry.provider} is absent from models.lock.json`)
      return entry.model_ids === "*" ? [] : entry.model_ids.map((model_id) => ({ provider: entry.provider, model_id }))
    }))
  ]
  for (const ref of required) {
    if (!lock.models.some((model) => model.provider === ref.provider && model.model_id === ref.model_id)) {
      throw new Error(`model ${ref.provider}/${ref.model_id} is absent from models.lock.json`)
    }
  }
  return { ...selected, providers: lockedProvidersOf(lock) }
}

// modelCatalogForConfig provides public discovery metadata derived from the lock (lock.test.ts).
export const modelCatalogForConfig = async (policy: ModelPolicy, lock: ModelLockData): Promise<ModelCatalog> => {
  const config = modelConfigForPolicy(policy, lock)
  const sourced = lock.models.filter((model) => model.source !== undefined).length
  const catalog: ModelCatalog = {
    source: sourced === 0 ? "custom" : sourced === lock.models.length ? "models.dev" : "mixed",
    revision: await sha256Of(JSON.stringify(lock)), refreshedAt: 0, status: "cached",
    providers: Object.entries(lock.providers).map(([id, connection]) => ({
      id, name: id, api: connection.baseUrl, env: connection.env,
      models: lock.models.filter((model) => model.provider === id).map((model) => {
        const { provider: _provider, model_id, source: _source, options: _options, ...metadata } = model
        return { id: model_id, metadata }
      })
    }))
  }
  return modelCatalogScopeOf(catalog, { providers: Object.keys(config.providers), policy: config })
}

// lockedModelState resolves runtime configuration and discovery from the ModelLock service (lock.test.ts).
export const lockedModelState = (policy: ModelPolicy) => Effect.gen(function*() {
  const lock = yield* ModelLock
  return yield* Effect.tryPromise({
    try: async () => ({ model: modelConfigForPolicy(policy, lock), catalog: { snapshot: await modelCatalogForConfig(policy, lock) } }),
    catch: modelLockErrorOf
  })
})
