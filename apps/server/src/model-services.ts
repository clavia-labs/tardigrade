import { Layer } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { FetchHttpClient } from "effect/unstable/http"
import { modelLayer, type ModelIntegrationOptions } from "@clavia/tardigrade-model/host"
import type { InferenceObserver } from "@clavia/tardigrade-agent"
import type { LanguageModel } from "effect/unstable/ai"
import type { ModelHostConfig } from "@clavia/tardigrade-model/selection"
import type { ModelCatalogState } from "@clavia/tardigrade-model/catalog"
import { catalogDiscoveryOf } from "@clavia/tardigrade-http/models"
import { readLockedCatalog } from "./catalog"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MODEL_LOCK_FILE } from "@clavia/tardigrade-model/lock"
import { projectConfigOf, projectConfigPathOf, readConfig } from "./config"
import { makeInferenceStream } from "@clavia/tardigrade-http/inference-stream"

type InferenceLayerFactory = (config: ModelHostConfig, catalog: ModelCatalogState, observer: InferenceObserver) => Layer.Layer<LanguageModel.LanguageModel>

export type BunModelServicesOptions = {
  readonly configFile?: string | URL
  readonly env: Parameters<typeof readConfig>[0]
  readonly lockFile?: string | URL
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
  const config = { ...readConfig(options.env, project), modelLockPath: lockFile instanceof URL ? fileURLToPath(lockFile) : resolve(lockFile) }
  const snapshot = await readLockedCatalog(config.model, config.modelLockPath)
  const inference = makeInferenceStream()
  const layers = Layer.mergeAll(
    options.inference === undefined ? modelLayer(config, snapshot, { ...options.model, observer: inference.observer }) : options.inference(config, snapshot, inference.observer),
    BunFileSystem.layer,
    BunPath.layer,
    FetchHttpClient.layer
  )

  const api = { inference, catalog: catalogDiscoveryOf(snapshot, config.model, config.modelCredentials) }
  return { config, layers, api }
}
