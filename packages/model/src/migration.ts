import { Schema } from "effect"
import { ModelCatalog } from "./catalog/schema"
import { modelConnectionsOf, type ModelConfig } from "./config"
import { MODEL_LOCK_SCHEMA, modelLockOf, modelConfigForPolicy, type ModelLockData } from "./lock"

// migrateModelLock moves saved version-one metadata and connections into the runtime lock without registry access (migration.test.ts).
export const migrateModelLock = (value: unknown, config: ModelConfig, source?: string): ModelLockData => {
  const legacy = Schema.decodeUnknownSync(Schema.Struct({ schema: Schema.Literal(1), catalog: ModelCatalog }))(value)
  const providers = modelConnectionsOf(config.providers)
  const models = Object.entries(config.providers).flatMap(([provider, connection]) => {
    const saved = legacy.catalog.providers.find((entry) => entry.id === provider)
    const ids = new Set([...(saved?.models.map((entry) => entry.id) ?? []), ...Object.keys(connection.models ?? {})])
    return [...ids].map((model_id) => {
      const found = saved?.models.find((entry) => entry.id === model_id)
      const custom = connection.models?.[model_id]
      return {
        provider, model_id, ...found?.metadata, ...custom?.metadata,
        ...(custom?.options === undefined ? {} : { options: custom.options }),
        ...(custom?.metadata !== undefined || source === undefined ? {} : { source })
      }
    })
  })
  const lock = modelLockOf({ schema: MODEL_LOCK_SCHEMA, providers, models })
  modelConfigForPolicy(config, lock)
  return lock
}
