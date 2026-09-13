import { Effect, Layer, Option } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { ModelRegistry, layerHttpModelRegistry } from "@clavia/tardigrade-model/registry"
import { layerMemoryModelCatalogRepository } from "@clavia/tardigrade-model/catalog-store"
import { layerFileModelCatalogRepository } from "@clavia/tardigrade-server/catalog-repository"

interface CliModelRegistryOptions {
  readonly sourceUrl: string
  readonly cachePath?: string
  readonly timeoutMillis: number
  readonly fetch?: typeof globalThis.fetch
}

// layerCliModelRegistry selects HTTP storage at the CLI boundary (commands.test.ts).
export const layerCliModelRegistry = (options: CliModelRegistryOptions): Layer.Layer<ModelRegistry> =>
  layerHttpModelRegistry(options).pipe(Layer.provide(options.cachePath === undefined
    ? layerMemoryModelCatalogRepository()
    : layerFileModelCatalogRepository(options.cachePath).pipe(Layer.provide(BunFileSystem.layer))))

// withModelRegistry preserves an injected registry and supplies the CLI default when absent (commands.test.ts).
export const withModelRegistry = <A, E, R>(effect: Effect.Effect<A, E, R>, options: CliModelRegistryOptions) =>
  Effect.gen(function*() {
    const supplied = yield* Effect.serviceOption(ModelRegistry)
    return Option.isSome(supplied)
      ? yield* effect.pipe(Effect.provideService(ModelRegistry, supplied.value))
      : yield* effect.pipe(Effect.provide(layerCliModelRegistry(options)))
  })
