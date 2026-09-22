import { Schema } from "effect"
import { ModelCatalog } from "./catalog/schema"
import { canonicalModelConfig, modelConfigOf } from "./config"
import { sha256Of } from "./digest"
import { MODEL_LOCK_FILE, MODEL_LOCK_SCHEMA, modelLockOf, type ModelLockData } from "./lock"

const LegacyLock = Schema.Struct({
  schema: Schema.Literal(1),
  configDigest: Schema.String,
  catalog: ModelCatalog
})

export type ModelLockSource = ModelLockData | typeof LegacyLock.Type

// modelLockSourceOf validates persisted lock versions before host configuration is available (lock-compat.test.ts).
export const modelLockSourceOf = (value: unknown, path = MODEL_LOCK_FILE): ModelLockSource => {
  if (typeof value === "object" && value !== null && "schema" in value && value.schema === 1) {
    try { return Schema.decodeUnknownSync(LegacyLock)(value) } catch (cause) {
      throw new Error(`${path} is invalid: ${String(cause)}`)
    }
  }
  return modelLockOf(value, path)
}

// upgradeModelLock combines a matching v1 catalog with manifest connections without network access (lock-compat.test.ts).
export const upgradeModelLock = async (source: ModelLockSource, models: unknown, path = MODEL_LOCK_FILE): Promise<ModelLockData> => {
  if (source.schema === MODEL_LOCK_SCHEMA) return source
  const config = modelConfigOf(models)
  if (source.configDigest !== await sha256Of(canonicalModelConfig(config))) {
    throw new Error(`${path} does not match model configuration; run \`tdg models lock\``)
  }
  return modelLockOf({
    schema: MODEL_LOCK_SCHEMA,
    providers: Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {
      protocol: provider.protocol, baseUrl: provider.baseUrl, env: provider.env,
      ...(provider.region === undefined ? {} : { region: provider.region })
    }])),
    models: source.catalog.providers.flatMap(provider => provider.models.map(model => ({
      ...model.metadata,
      provider: provider.id,
      model_id: model.id,
      ...(config.providers[provider.id]?.models?.[model.id]?.options === undefined ? {} : {
        options: config.providers[provider.id]!.models![model.id]!.options
      })
    })))
  }, path)
}
