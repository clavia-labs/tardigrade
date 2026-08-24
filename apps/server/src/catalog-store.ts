import { Context, Data, Effect, Layer } from "effect"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"

export class ModelCatalogRepositoryError extends Data.TaggedError("ModelCatalogRepositoryError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ModelCatalogRepositoryService {
  readonly read: (sourceUrl: string) => Effect.Effect<ModelCatalog | undefined, ModelCatalogRepositoryError>
  readonly write: (sourceUrl: string, snapshot: ModelCatalog) => Effect.Effect<void, ModelCatalogRepositoryError>
}

// ModelCatalogRepository persists validated snapshots across server and CLI process lifetimes.
export class ModelCatalogRepository extends Context.Service<
  ModelCatalogRepository,
  ModelCatalogRepositoryService
>()("tardigrade/server/ModelCatalogRepository") {}

// layerMemoryModelCatalogRepository keeps source-keyed snapshots for tests and embeddings.
export const layerMemoryModelCatalogRepository = (
  initial: ReadonlyArray<readonly [string, ModelCatalog]> = []
): Layer.Layer<ModelCatalogRepository> => {
  const snapshots = new Map(initial)
  return Layer.succeed(ModelCatalogRepository)({
    read: (sourceUrl) => Effect.succeed(
      snapshots.get(sourceUrl) === undefined ? undefined : { ...snapshots.get(sourceUrl)!, status: "cached" }
    ),
    write: (sourceUrl, snapshot) => Effect.sync(() => {
      snapshots.set(sourceUrl, snapshot)
    })
  })
}
