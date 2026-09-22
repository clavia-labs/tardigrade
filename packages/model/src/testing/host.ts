import { Layer } from "effect"
import { ModelLock, modelLockOf, modelLockService } from "../lock"
import { modelLayer } from "../host"
import type { ModelHostConfig } from "../selection"
import type { ModelCatalogState } from "../catalog"

// fixtureModelLock supplies explicit definitions for provider fixtures.
export const fixtureModelLock = (config: ModelHostConfig, catalog: ModelCatalogState) => {
  const definitions = modelLockOf({
    schema: 2,
    providers: Object.fromEntries(Object.entries(config.model.providers).map(([id, { models: _models, ...connection }]) => [id, connection])),
    models: (catalog.snapshot?.providers ?? []).flatMap(provider => provider.models.map(model => ({
      ...model.metadata, provider: provider.id, model_id: model.id,
      ...(config.model.providers[provider.id]?.models?.[model.id]?.options === undefined ? {} : {
        options: config.model.providers[provider.id]!.models![model.id]!.options
      })
    })))
  })
  return Layer.succeed(ModelLock, modelLockService(definitions, config.model))
}

// fixtureModelLayer binds provider fixtures to their explicitly supplied model data.
export const fixtureModelLayer = (...[config, catalog, options]: Parameters<typeof modelLayer>) =>
  modelLayer(config, catalog, options).pipe(Layer.provideMerge(fixtureModelLock(config, catalog)))
