import { Context, Data, Effect, Layer } from "effect"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"
import { modelAllowedBy, type ModelPolicy } from "tardie"

export class ModelCatalogRepositoryError extends Data.TaggedError("ModelCatalogRepositoryError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ModelCatalogRepositoryService {
  readonly read: (sourceUrl: string) => Effect.Effect<ModelCatalog | undefined, ModelCatalogRepositoryError>
  readonly readScope: (
    sourceUrl: string,
    scope: ModelCatalogScope
  ) => Effect.Effect<ModelCatalog | undefined, ModelCatalogRepositoryError>
  readonly write: (sourceUrl: string, snapshot: ModelCatalog) => Effect.Effect<void, ModelCatalogRepositoryError>
}

export interface ModelCatalogScope {
  readonly providers: ReadonlyArray<string>
  readonly policy: ModelPolicy
}

// modelCatalogScopeOf projects a validated catalog through configured providers and model policy.
export const modelCatalogScopeOf = (snapshot: ModelCatalog, scope: ModelCatalogScope): ModelCatalog => {
  const providers = new Set(scope.providers)
  return {
    ...snapshot,
    providers: snapshot.providers.flatMap((provider) => {
      if (!providers.has(provider.id)) return []
      const models = provider.models.filter((model) =>
        modelAllowedBy(scope.policy, { provider: provider.id, model_id: model.id })
      )
      return models.length === 0 ? [] : [{ ...provider, models }]
    })
  }
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
    readScope: (sourceUrl, scope) => Effect.succeed(
      snapshots.get(sourceUrl) === undefined
        ? undefined
        : modelCatalogScopeOf({ ...snapshots.get(sourceUrl)!, status: "cached" }, scope)
    ),
    write: (sourceUrl, snapshot) => Effect.sync(() => {
      snapshots.set(sourceUrl, snapshot)
    })
  })
}
