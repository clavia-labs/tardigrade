import { Context, Effect, Layer } from "effect"
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

// layerLockedServerModels derives configuration and discovery together from the lock (model-services.test.ts).
export const layerLockedServerModels = (config: ServerConfigValue, env: Env = config.modelCredentials): Layer.Layer<ServerConfig | ModelCatalogStore, ModelLockError, ModelLock> =>
  Layer.effectContext(Effect.map(lockedModelState(config.model), ({ model, catalog }) =>
    Context.make(ServerConfig, { ...config, model, modelCredentials: modelCredentialsFrom(model, env) }).pipe(
      Context.add(ModelCatalogStore, catalog)
    )))
