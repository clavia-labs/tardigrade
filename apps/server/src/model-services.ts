import { Effect, Layer } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { FetchHttpClient } from "effect/unstable/http"
import { modelLayer, type ModelHostOptions } from "@clavia/tardigrade-model/host"
import type { InferenceObserver } from "@clavia/tardigrade-agent"
import type { LanguageModel } from "effect/unstable/ai"
import type { ModelHostConfig } from "@clavia/tardigrade-model/selection"
import type { ModelCatalogState } from "@clavia/tardigrade-model/catalog"
import { catalogDiscoveryOf } from "@clavia/tardigrade-http/models"
import { ModelCatalogStore, layerModelCatalog } from "./catalog"
import { layerFileModelCatalogRepository } from "./catalog-repository"
import { layerConfig, projectConfigOf, projectConfigPathOf, readConfig } from "./config"
import { makeInferenceStream } from "@clavia/tardigrade-http/inference-stream"

type InferenceLayerFactory = (config: ModelHostConfig, catalog: ModelCatalogState, observer: InferenceObserver) => Layer.Layer<LanguageModel.LanguageModel>

export type BunModelServicesOptions = {
  readonly configFile?: string | URL
  readonly env: Parameters<typeof readConfig>[0]
  readonly catalog?: Parameters<typeof layerModelCatalog>[0]
  readonly inference?: InferenceLayerFactory
  readonly configure?: ModelHostOptions["configure"]
  readonly providerLayer?: ModelHostOptions["providerLayer"]
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
  const config = readConfig(options.env, project)
  const configLayer = layerConfig(config)
  const catalogRepository = layerFileModelCatalogRepository(config.catalog.cachePath).pipe(
    Layer.provide(BunFileSystem.layer)
  )
  const catalog = Layer.provide(layerModelCatalog(options.catalog), [configLayer, catalogRepository])
  const snapshot = await Effect.runPromise(ModelCatalogStore.pipe(Effect.provide(catalog)))
  const inference = makeInferenceStream()
  const layers = Layer.mergeAll(
    options.inference === undefined ? modelLayer(config, snapshot, { observer: inference.observer, ...(options.providerLayer === undefined ? {} : { providerLayer: options.providerLayer }), ...(options.configure === undefined ? {} : { configure: options.configure }) }) : options.inference(config, snapshot, inference.observer),
    BunFileSystem.layer,
    BunPath.layer,
    FetchHttpClient.layer
  )

  const api = { inference, catalog: catalogDiscoveryOf(snapshot, config.model, config.modelCredentials) }
  return { config, layers, api }
}
