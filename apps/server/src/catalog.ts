import { Effect, Layer } from "effect"
import { ServerConfig } from "./config"
import { ModelCatalogRepository } from "@clavia/tardigrade-model/catalog/repository"
import { ModelCatalogStore, loadModelCatalog, type ModelCatalogLoadOptions, type ModelCatalogLoadPolicy } from "@clavia/tardigrade-model/catalog"
export * from "@clavia/tardigrade-model/catalog"

export const DEFAULT_SERVER_MODEL_CATALOG_LOAD_POLICY: ModelCatalogLoadPolicy = "refresh"

// layerModelCatalog refreshes the configured source once for the lifetime of the server process.
export const layerModelCatalog = (
  options: Partial<Pick<ModelCatalogLoadOptions, "fetch" | "now" | "policy">> = {}
): Layer.Layer<ModelCatalogStore, never, ServerConfig | ModelCatalogRepository> =>
  Layer.effect(
    ModelCatalogStore,
    Effect.flatMap(ServerConfig, (config) =>
      Effect.tap(
        loadModelCatalog({
          sourceUrl: config.catalog.sourceUrl,
          timeoutMillis: config.catalog.timeoutMillis,
          policy: options.policy ?? DEFAULT_SERVER_MODEL_CATALOG_LOAD_POLICY,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.now === undefined ? {} : { now: options.now })
        }),
        (state) => Effect.all([
          state.refreshError === undefined ? Effect.void : Effect.logWarning(`model catalog refresh failed: ${state.refreshError}`),
          state.cacheError === undefined ? Effect.void : Effect.logWarning(`model catalog cache failed: ${state.cacheError}`)
        ], { discard: true })
      ))
  )
