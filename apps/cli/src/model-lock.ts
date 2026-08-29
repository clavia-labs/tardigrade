import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { ModelCatalog as ModelCatalogSchema, type ModelCatalog } from "@clavia/tardigrade-client/contract"
import { loadModelCatalog } from "@clavia/tardigrade-server/catalog"
import { layerFileModelCatalogRepository } from "@clavia/tardigrade-server/catalog-repository"
import { modelCatalogScopeOf } from "@clavia/tardigrade-server/catalog-store"
import type { ModelConfig } from "@clavia/tardigrade-server/config"

export const MODEL_LOCK_SCHEMA = 1
export const MODEL_LOCK_FILE = "models.lock.json"

export interface ModelLock {
  readonly schema: typeof MODEL_LOCK_SCHEMA
  readonly configDigest: string
  readonly catalog: ModelCatalog
}

export interface ResolveModelLockOptions {
  readonly sourceUrl: string
  readonly cachePath: string
  readonly timeoutMillis: number
  readonly fetch?: typeof globalThis.fetch
}

export const emptyModelLock = (): ModelLock => ({
  schema: MODEL_LOCK_SCHEMA,
  configDigest: modelConfigDigest({ allow: "*", providers: {} }),
  catalog: {
    source: "models.dev",
    revision: "empty",
    refreshedAt: 0,
    status: "cached",
    providers: []
  }
})

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]))
}

// modelConfigDigest identifies the visible provider and model policy resolved by one lock.
export const modelConfigDigest = (config: ModelConfig): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonical(config))).digest("hex")}`

// resolveModelLock resolves deployment model policy against one validated public catalog snapshot.
export const resolveModelLock = async (
  config: ModelConfig,
  options: ResolveModelLockOptions
): Promise<ModelLock> => {
  const repository = layerFileModelCatalogRepository(options.cachePath).pipe(Layer.provide(BunFileSystem.layer))
  const state = await Effect.runPromise(loadModelCatalog({
    sourceUrl: options.sourceUrl,
    timeoutMillis: options.timeoutMillis,
    policy: "refresh",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  }).pipe(Effect.provide(repository)))
  if (state.snapshot === undefined) throw new Error(state.refreshError ?? state.cacheError ?? "model catalog is unavailable")
  const catalog = modelCatalogScopeOf(state.snapshot, {
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
  return {
    schema: MODEL_LOCK_SCHEMA,
    configDigest: modelConfigDigest(config),
    catalog
  }
}

export const writeModelLock = async (root: string, lock: ModelLock): Promise<string> => {
  const path = resolve(root, MODEL_LOCK_FILE)
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8")
  return path
}

export const readModelLock = async (root: string): Promise<ModelLock> => {
  const path = resolve(root, MODEL_LOCK_FILE)
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ModelLock>
  if (parsed.schema !== MODEL_LOCK_SCHEMA || typeof parsed.configDigest !== "string" || parsed.catalog === undefined) {
    throw new Error(`${MODEL_LOCK_FILE} is invalid; run \`tdg models lock\``)
  }
  return { schema: MODEL_LOCK_SCHEMA, configDigest: parsed.configDigest, catalog: Schema.decodeSync(ModelCatalogSchema)(parsed.catalog) }
}

export const assertModelLockCurrent = (config: ModelConfig, lock: ModelLock): void => {
  if (lock.configDigest !== modelConfigDigest(config)) {
    throw new Error(`${MODEL_LOCK_FILE} does not match model configuration; run \`tdg models lock\``)
  }
}
