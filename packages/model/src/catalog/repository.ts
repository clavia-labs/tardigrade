import { Data, Effect } from "effect"
import type { ModelCatalog } from "@clavia/tardigrade-model/catalog/schema"
import { modelAllowedBy, type ModelPolicy } from "../access"

export class ModelRegistryError extends Data.TaggedError("ModelRegistryError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ModelRegistryCache {
  readonly read: (sourceUrl: string) => Effect.Effect<ModelCatalog | undefined, ModelRegistryError>
  readonly readScope: (
    sourceUrl: string,
    scope: ModelCatalogScope
  ) => Effect.Effect<ModelCatalog | undefined, ModelRegistryError>
  readonly write: (sourceUrl: string, snapshot: ModelCatalog) => Effect.Effect<void, ModelRegistryError>
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
