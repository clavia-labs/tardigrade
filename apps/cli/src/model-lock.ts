import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Effect, Layer } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { loadModelCatalog, modelCatalogWithConfiguredModels } from "@clavia/tardigrade-server/catalog"
import { layerFileModelRegistry } from "@clavia/tardigrade-server/catalog-repository"
import { modelCatalogScopeOf } from "@clavia/tardigrade-server/catalog-store"
import type { ModelConfig } from "@clavia/tardigrade-server/config"

import { MODEL_LOCK_FILE, MODEL_LOCK_SCHEMA, emptyModelLock, modelLockOf, parseModelLock, type ModelLockData } from "@clavia/tardigrade-model/lock"
export { MODEL_LOCK_FILE, emptyModelLock } from "@clavia/tardigrade-model/lock"
export type ModelLock = ModelLockData

export interface ResolveModelLockOptions {
  readonly sourceUrl: string
  readonly cachePath: string
  readonly timeoutMillis: number
  readonly fetch?: typeof globalThis.fetch
}

// resolveModelLock resolves deployment model policy against one validated public catalog snapshot.
export const resolveModelLock = async (
  config: ModelConfig,
  options?: ResolveModelLockOptions
): Promise<ModelLock> => {
  if (Object.keys(config.providers).length === 0) return emptyModelLock()
  const required = [
    ...(config.default === undefined ? [] : [config.default]),
    ...(config.fallback ?? []),
    ...(config.allow === "*" ? [] : config.allow.flatMap(entry => entry.model_ids === "*" ? [] : entry.model_ids.map(model_id => ({ provider: entry.provider, model_id }))))
  ]
  const explicit = required.every(model => config.providers[model.provider]?.models?.[model.model_id]?.metadata?.contextWindowTokens !== undefined) && Object.values(config.providers).every(provider => {
    const models = Object.values(provider.models ?? {})
    return models.length > 0 && models.every(model => model.metadata?.contextWindowTokens !== undefined)
  })
  const state = explicit ? {} : await (async () => {
    if (options === undefined) throw new Error("model metadata is incomplete; supply explicit metadata or registry options")
    const repository = layerFileModelRegistry(options.cachePath).pipe(Layer.provide(BunFileSystem.layer))
    return Effect.runPromise(loadModelCatalog({
      sourceUrl: options.sourceUrl,
      timeoutMillis: options.timeoutMillis,
      policy: "refresh",
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    }).pipe(Effect.provide(repository)))
  })()
  const snapshot = await modelCatalogWithConfiguredModels(config, state.snapshot)
  if (snapshot === undefined) throw new Error(state.refreshError ?? state.cacheError ?? "model metadata is unavailable")
  const catalog = modelCatalogScopeOf(snapshot, {
    providers: Object.keys(config.providers),
    policy: config
  })
  const selected = config.default
  const selectedExists = selected === undefined || catalog.providers.some((provider) =>
    provider.id === selected.provider && provider.models.some((model) => model.id === selected.model_id)
  )
  if (!selectedExists) {
    throw new Error(`default model ${selected.provider}/${selected.model_id} is absent from catalog revision ${JSON.stringify(catalog.revision)}`)
  }
  return modelLockOf({
    schema: MODEL_LOCK_SCHEMA,
    providers: Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {
      protocol: provider.protocol, baseUrl: provider.baseUrl, env: provider.env,
      ...(provider.region === undefined ? {} : { region: provider.region })
    }])),
    models: catalog.providers.flatMap(provider => provider.models.map(model => {
      const configured = config.providers[provider.id]?.models?.[model.id]
      return {
        ...model.metadata, provider: provider.id, model_id: model.id,
        ...(configured?.options === undefined ? {} : { options: configured.options }),
        ...(configured?.metadata === undefined && options !== undefined ? { source: options.sourceUrl } : {})
      }
    }))
  })
}

export const writeModelLock = async (root: string, lock: ModelLock): Promise<string> => {
  const path = resolve(root, MODEL_LOCK_FILE)
  await writeFile(path, `${JSON.stringify(modelLockOf(lock, path), null, 2)}\n`, "utf8")
  return path
}

export const readModelLock = async (root: string): Promise<ModelLock> => {
  const path = resolve(root, MODEL_LOCK_FILE)
  return parseModelLock(await readFile(path, "utf8"), path)
}
