import { sha256Of } from "./digest"
import { Schema } from "effect"
import { ModelCatalog } from "./catalog/schema"
import { canonicalModelConfig, type ModelConfig } from "./config"

export const MODEL_LOCK_SCHEMA = 1
export const MODEL_LOCK_FILE = "models.lock.json"

export interface ModelLock {
  readonly schema: typeof MODEL_LOCK_SCHEMA
  readonly configDigest: string
  readonly catalog: ModelCatalog
}

export interface ModelScope {
  readonly configDigest: string
  readonly catalog: ModelCatalog
}

// modelLockOf validates a persisted model lock (lock.test.ts).
export const modelLockOf = (value: unknown): ModelLock => {
  const parsed = Schema.decodeUnknownSync(Schema.Struct({
    schema: Schema.Literal(MODEL_LOCK_SCHEMA),
    configDigest: Schema.NonEmptyString,
    catalog: ModelCatalog
  }))(value)
  const providers = new Set<string>()
  for (const provider of parsed.catalog.providers) {
    if (providers.has(provider.id)) throw new Error(`duplicate model provider ${provider.id}`)
    providers.add(provider.id)
    const models = new Set<string>()
    for (const model of provider.models) {
      if (models.has(model.id)) throw new Error(`duplicate model ${provider.id}/${model.id}`)
      models.add(model.id)
    }
  }
  return parsed
}

// modelConfigDigest identifies configuration bound to a model lock (lock.test.ts).
export const modelConfigDigest = (config: ModelConfig): Promise<string> =>
  sha256Of(canonicalModelConfig(config))

// modelCatalogForConfig checks the configuration bound to a runtime lock (lock.test.ts).
export const modelCatalogForConfig = async (config: ModelConfig, scope: ModelScope): Promise<ModelCatalog> => {
  const expected = await modelConfigDigest(config)
  if (scope.configDigest !== expected) throw new Error("models.lock.json does not match model configuration; run `tdg models lock`")
  const selected = config.default
  if (selected !== undefined) {
    const model = scope.catalog.providers.find((provider) => provider.id === selected.provider)?.models.find((model) => model.id === selected.model_id)
    if (model === undefined) throw new Error(`default model ${selected.provider}/${selected.model_id} is absent from models.lock.json`)
    if (model.metadata.contextWindowTokens === undefined) throw new Error(`model ${selected.provider}/${selected.model_id} must declare contextWindowTokens`)
  }
  return scope.catalog
}
