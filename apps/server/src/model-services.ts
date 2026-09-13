import { Effect, Layer } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { FetchHttpClient } from "effect/unstable/http"
import { modelLayerFromLock, type ModelIntegrationOptions } from "@clavia/tardigrade-model/host"
import type { InferenceObserver } from "@clavia/tardigrade-agent"
import type { LanguageModel } from "effect/unstable/ai"
import type { ModelHostConfig } from "@clavia/tardigrade-model/selection"
import type { ModelCatalogState } from "@clavia/tardigrade-model/catalog"
import { catalogDiscoveryOf } from "@clavia/tardigrade-http/models"
import { layerRuntimeModelLock } from "./catalog"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MODEL_LOCK_FILE, lockedModelState, ModelLock, ModelLockError } from "@clavia/tardigrade-model/lock"
import { projectConfigOf, projectConfigPathOf, readConfig, modelCredentialsFrom } from "./config"
import { makeInferenceStream } from "@clavia/tardigrade-http/inference-stream"

type InferenceLayerFactory = (config: ModelHostConfig, catalog: ModelCatalogState, observer: InferenceObserver) => Layer.Layer<LanguageModel.LanguageModel>

export type BunModelServicesOptions = {
  readonly configFile?: string | URL
  readonly env: Parameters<typeof readConfig>[0]
  readonly lockFile?: string | URL
  readonly lock?: Layer.Layer<ModelLock, ModelLockError>
  readonly inference?: InferenceLayerFactory
  readonly model?: ModelIntegrationOptions
}

// bunModelServices binds configured model inference, catalog discovery, and Bun services for a host.
export const bunModelServices = async (options: BunModelServicesOptions) => {
  const configPath = options.configFile ?? projectConfigPathOf(options.env)
  const projectFile = Bun.file(configPath)
  const exists = await projectFile.exists()
  if (!exists && (options.configFile !== undefined || options.env.TARDIGRADE_CONFIG_PATH?.trim().length)) {
    throw new Error(`project configuration ${JSON.stringify(String(configPath))} does not exist`)
  }
  const project = exists ? projectConfigOf(Bun.JSONC.parse(await projectFile.text())) : projectConfigOf({})
  const lockFile = options.lockFile ?? resolve(dirname(configPath instanceof URL ? fileURLToPath(configPath) : configPath), MODEL_LOCK_FILE)
  const initial = { ...readConfig(options.env, project), modelLockPath: lockFile instanceof URL ? fileURLToPath(lockFile) : resolve(lockFile) }
  if (options.lock !== undefined && options.lockFile !== undefined) throw new Error("supply lock or lockFile, not both")
  const lockLoader = options.lock ?? layerRuntimeModelLock(initial).pipe(Layer.provide(BunFileSystem.layer))
  const lockValue = await Effect.runPromise(ModelLock.pipe(Effect.provide(lockLoader)))
  const lockLayer = Layer.succeed(ModelLock)(lockValue)
  const runtime = await Effect.runPromise(lockedModelState(initial.model).pipe(Effect.provide(lockLayer)))
  const config = { ...initial, model: runtime.model, modelCredentials: modelCredentialsFrom(runtime.model, options.env) }
  const snapshot = runtime.catalog
  const inference = makeInferenceStream()
  const layers = Layer.mergeAll(
    options.inference === undefined ? modelLayerFromLock(config.model, config.modelCredentials, { ...options.model, observer: inference.observer }).pipe(Layer.provide(lockLayer), Layer.orDie) : options.inference(config, snapshot, inference.observer),
    lockLayer,
    BunFileSystem.layer,
    BunPath.layer,
    FetchHttpClient.layer
  )

  const api = { inference, catalog: catalogDiscoveryOf(snapshot, config.model, config.modelCredentials) }
  return { config, layers, api }
}
