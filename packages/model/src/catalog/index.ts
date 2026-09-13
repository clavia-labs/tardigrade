import { Context, Layer } from "effect"
import type { ModelCatalog } from "./schema"

export interface ModelCatalogState {
  readonly snapshot?: ModelCatalog
  readonly refreshError?: string
  readonly cacheError?: string
}

// ModelCatalogStore holds the snapshot resolved once when this server starts.
export class ModelCatalogStore extends Context.Service<
  ModelCatalogStore,
  ModelCatalogState
>()("tardigrade/server/ModelCatalogStore") {}

export const layerModelCatalogValue = (snapshot: ModelCatalog): Layer.Layer<ModelCatalogStore> =>
  Layer.succeed(ModelCatalogStore)({ snapshot })

export const layerModelCatalogUnavailable: Layer.Layer<ModelCatalogStore> =
  Layer.succeed(ModelCatalogStore)({ refreshError: "no validated model catalog is available" })
