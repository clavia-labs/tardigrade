import { readFile } from "node:fs/promises"
import { Data, Effect, Layer } from "effect"
import { modelLockOf, modelCatalogForConfig } from "@clavia/tardigrade-model/lock"
import { ServerConfig } from "./config"
import { ModelCatalogStore, type ModelCatalogState } from "@clavia/tardigrade-model/catalog"
import type { ModelConfig } from "@clavia/tardigrade-model/config"
export * from "@clavia/tardigrade-model/catalog"

// readLockedCatalog loads runtime metadata without registry access (model-services.test.ts).
export const readLockedCatalog = async (config: ModelConfig, path: string): Promise<ModelCatalogState> => {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      if (Object.keys(config.providers).length === 0 && config.default === undefined) return {}
      throw new Error(`${path} is missing; run \`tdg models lock\``)
    }
    throw error
  }
  return { snapshot: await modelCatalogForConfig(config, modelLockOf(JSON.parse(raw))) }
}

export class ModelLockError extends Data.TaggedError("ModelLockError")<{ readonly message: string; readonly cause: unknown }> {}

// layerModelCatalog supplies the locked runtime snapshot (model-services.test.ts).
export const layerModelCatalog = (options: { readonly lockFile?: string } = {}): Layer.Layer<ModelCatalogStore, ModelLockError, ServerConfig> =>
  Layer.effect(ModelCatalogStore, Effect.flatMap(ServerConfig, (config) => Effect.tryPromise({
    try: () => readLockedCatalog(config.model, options.lockFile ?? config.modelLockPath),
    catch: (cause) => new ModelLockError({ message: cause instanceof Error ? cause.message : String(cause), cause })
  })))
