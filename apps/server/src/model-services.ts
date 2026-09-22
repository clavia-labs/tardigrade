import { modelLockSourceOf, upgradeModelLock } from "@clavia/tardigrade-model/lock-compat"
import { ModelLock, MODEL_LOCK_FILE, lockedModelConfigOf, modelLockService, modelCatalogForConfig } from "@clavia/tardigrade-model/lock"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Layer } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { FetchHttpClient } from "effect/unstable/http"
import { modelLayer, type ModelIntegrationOptions } from "@clavia/tardigrade-model/host"
import type { InferenceObserver } from "@clavia/tardigrade-agent"
import type { LanguageModel } from "effect/unstable/ai"
import type { ModelHostConfig } from "@clavia/tardigrade-model/selection"
import type { ModelCatalogState } from "@clavia/tardigrade-model/catalog"
import { catalogDiscoveryOf } from "@clavia/tardigrade-http/models"
import { projectModelsOf, projectConfigPathOf, readConfig } from "./config"
import { makeInferenceStream } from "@clavia/tardigrade-http/inference-stream"

type InferenceLayerFactory = (config: ModelHostConfig, catalog: ModelCatalogState, observer: InferenceObserver) => Layer.Layer<LanguageModel.LanguageModel | ModelLock, never, ModelLock>

export type BunModelServicesOptions = {
  readonly configFile?: string | URL
  readonly env: Parameters<typeof readConfig>[0]
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
  const path = resolve(dirname(configPath instanceof URL ? fileURLToPath(configPath) : configPath), MODEL_LOCK_FILE)
  const file = Bun.file(path)
  const models = projectModelsOf(exists ? Bun.JSONC.parse(await projectFile.text()) : {})
  const definitions = await file.exists() ? await upgradeModelLock(modelLockSourceOf(await file.json(), path), models, path)
    : (() => { throw new Error(`${path} is missing; run \`tdg models lock\``) })()
  const project = { models: lockedModelConfigOf(models, definitions) }
  const config = readConfig(options.env, project)
  const { providers: _providers, ...policy } = config.model
  const snapshot = { snapshot: await modelCatalogForConfig(policy, definitions) }
  const inference = makeInferenceStream()
  const binding = options.inference === undefined ? modelLayer({ credentials: config.modelCredentials, ...options.model, observer: inference.observer }) : options.inference(config, snapshot, inference.observer)
  const layers = Layer.mergeAll(
    binding.pipe(Layer.provideMerge(Layer.succeed(ModelLock, modelLockService(definitions, policy)))),
    BunFileSystem.layer,
    BunPath.layer,
    FetchHttpClient.layer
  )

  const api = { inference, catalog: catalogDiscoveryOf(snapshot, config.model, config.modelCredentials) }
  return { config, layers, api, catalog: snapshot }
}
