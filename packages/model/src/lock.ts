import { Context, Data, Effect, Layer, Schema, SchemaIssue } from "effect"
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

export const modelLockErrorOf = (cause: unknown): ModelLockError => cause instanceof ModelLockError ? cause : new ModelLockError({
  message: cause instanceof Error ? cause.message : String(cause), cause
})

// ModelLock supplies validated runtime definitions independently of their loader (lock.test.ts).
export class ModelLock extends Context.Service<ModelLock, ModelLockData>()("tardigrade/model/ModelLock") {}

export const emptyModelLock = (): ModelLockData => ({ schema: MODEL_LOCK_SCHEMA, providers: {}, models: [] })

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const schemaMessage = (cause: Schema.SchemaError, value: unknown): string =>
  SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue).issues.map((issue) => {
    const path = (issue.path ?? []).map((entry) => typeof entry === "object" ? entry.key : entry)
    const models = recordOf(value)?.models
    const model = path[0] === "models" && typeof path[1] === "number" && Array.isArray(models) ? recordOf(models[path[1]]) : undefined
    const coordinate = typeof model?.provider === "string" && typeof model.model_id === "string" ? ` (model ${model.provider}/${model.model_id})` : ""
    return `${path.map((key) => `[${JSON.stringify(key)}]`).join("") || "root"}${coordinate}: ${issue.message}`
  }).join("\n")

const requireHttpUrl = (value: string, field: string): void => {
  let url: URL
  try { url = new URL(value) } catch {
    throw new Error(`${field} must be an absolute HTTP(S) URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${field} must be an absolute HTTP(S) URL`)
}

// modelLockOf validates complete definitions and reports their paths and coordinates (lock.test.ts).
export const modelLockOf = (value: unknown, path = MODEL_LOCK_FILE): ModelLockData => {
  try {
    const version = recordOf(value)?.schema
    if (version === 1) throw new Error("schema 1 is unsupported. Run `tdg setup` to migrate saved definitions offline, or `tdg models lock` to migrate and refresh")
    if (typeof version === "number" && version !== MODEL_LOCK_SCHEMA) throw new Error(`unsupported schema ${version}; this runtime supports schema ${MODEL_LOCK_SCHEMA}`)
    const lock = Schema.decodeUnknownSync(LockSchema, { onExcessProperty: "error" })(value)
    for (const [id, provider] of Object.entries(lock.providers)) {
      const field = `providers[${JSON.stringify(id)}]`
      requireHttpUrl(provider.baseUrl, `${field}.baseUrl`)
      try { modelProvidersOf({ [id]: provider }) } catch (cause) {
        throw new Error(`${field}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
      }
    }
    const coordinates = new Map<string, number>()
    for (const [index, model] of lock.models.entries()) {
      const key = JSON.stringify([model.provider, model.model_id])
      const field = `models[${index}]`
      const modelName = `model ${model.provider}/${model.model_id}`
      const previous = coordinates.get(key)
      if (previous !== undefined) throw new Error(`${field}: duplicate ${modelName}; first declared at models[${previous}]`)
      coordinates.set(key, index)
      const provider = lock.providers[model.provider]
      if (provider === undefined) throw new Error(`${field}.provider (${modelName}) references an absent provider; add providers[${JSON.stringify(model.provider)}]`)
      try { modelSettingsOf(provider.protocol, { [model.model_id]: { options: model.options } }) } catch (cause) {
        throw new Error(`${field}.options (${modelName}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
      }
      if (model.source !== undefined) requireHttpUrl(model.source, `${field}.source (${modelName})`)
    }
    return lock
  } catch (cause) {
    const detail = Schema.isSchemaError(cause) ? schemaMessage(cause, value) : cause instanceof Error ? cause.message : String(cause)
    throw new ModelLockError({ message: `${path} is invalid: ${detail}`, cause })
  }
}

// parseModelLock includes the source path in JSON syntax and definition errors (lock.test.ts).
export const parseModelLock = (raw: string, path = MODEL_LOCK_FILE): ModelLockData => {
  let value: unknown
  try { value = JSON.parse(raw) } catch (cause) {
    throw new ModelLockError({ message: `${path} is invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
  }
  return modelLockOf(value, path)
}

// layerModelLock validates an in-memory definition without reading a file (lock.test.ts).
export const layerModelLock = (value: unknown): Layer.Layer<ModelLock, ModelLockError> =>
  Layer.effect(ModelLock)(Effect.try({ try: () => modelLockOf(value), catch: modelLockErrorOf }))

// layerFileModelLock reads the same schema through an injected filesystem (lock.test.ts).
export const layerFileModelLock = (path: string): Layer.Layer<ModelLock, ModelLockError, FileSystem> =>
  Layer.effect(ModelLock)(Effect.gen(function*() {
    const raw = yield* (yield* FileSystem).readFileString(path).pipe(Effect.mapError(modelLockErrorOf))
    return yield* Effect.try({ try: () => parseModelLock(raw, path), catch: modelLockErrorOf })
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
    ...(selected.default === undefined ? [] : [{ ...selected.default, field: "models.default" }]),
    ...(selected.allow === "*" ? [] : selected.allow.flatMap((entry, index) => {
      if (!lock.models.some((model) => model.provider === entry.provider)) throw new Error(`models.allow[${index}]: allowed provider ${entry.provider} is absent from models.lock.json`)
      return entry.model_ids === "*" ? [] : entry.model_ids.map((model_id, modelIndex) => ({ provider: entry.provider, model_id, field: `models.allow[${index}].model_ids[${modelIndex}]` }))
    }))
  ]
  for (const ref of required) {
    if (!lock.models.some((model) => model.provider === ref.provider && model.model_id === ref.model_id)) {
      throw new Error(`${ref.field}: model ${ref.provider}/${ref.model_id} is absent from models.lock.json`)
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
