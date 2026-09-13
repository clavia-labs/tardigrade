import { Effect, Layer } from "effect"
import { FileSystem } from "effect/FileSystem"
import { emptyModelLock, layerFileModelLock, layerModelLock, lockedModelState, ModelLock, ModelLockError, modelLockErrorOf } from "@clavia/tardigrade-model/lock"
import { ServerConfig, modelCredentialsFrom, type Env, type ServerConfigValue } from "./config"
import { ModelCatalogStore } from "@clavia/tardigrade-model/catalog"
export * from "@clavia/tardigrade-model/catalog"

// layerRuntimeModelLock permits an empty lock only for an unconfigured project (model-services.test.ts).
export const layerRuntimeModelLock = (config: ServerConfigValue): Layer.Layer<ModelLock, ModelLockError, FileSystem> =>
  Layer.unwrap(Effect.gen(function*() {
    const exists = yield* (yield* FileSystem).exists(config.modelLockPath).pipe(Effect.mapError(modelLockErrorOf))
    if (!exists && config.model.default === undefined && Object.keys(config.model.providers).length === 0 && (config.model.allow === "*" || config.model.allow.length === 0)) return layerModelLock(emptyModelLock())
    return layerFileModelLock(config.modelLockPath)
  }))

// layerLockedServerConfig derives connections and credentials from the supplied lock (model-services.test.ts).
export const layerLockedServerConfig = (config: ServerConfigValue, env: Env = config.modelCredentials): Layer.Layer<ServerConfig, ModelLockError, ModelLock> =>
  Layer.effect(ServerConfig)(Effect.map(lockedModelState(config.model), ({ model }) => ({
    ...config, model, modelCredentials: modelCredentialsFrom(model, env)
  })))

// layerModelCatalog derives discovery from the runtime lock service (model-services.test.ts).
export const layerModelCatalog: Layer.Layer<ModelCatalogStore, ModelLockError, ModelLock | ServerConfig> =
  Layer.effect(ModelCatalogStore)(Effect.gen(function*() {
    const config = yield* ServerConfig
    return (yield* lockedModelState(config.model)).catalog
  }))
