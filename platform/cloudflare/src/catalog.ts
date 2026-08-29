import { Effect, Layer, Schema } from "effect"
import { ModelCatalog as ModelCatalogSchema, type ModelCatalog } from "@clavia/tardigrade-client/contract"
import {
  ModelCatalogRepository,
  ModelCatalogRepositoryError,
  modelCatalogScopeOf,
  type ModelCatalogRepositoryService,
  type ModelCatalogScope
} from "@clavia/tardigrade-server/catalog-store"

// DEFAULT_MODEL_CATALOG_WRITE_BATCH_SIZE bounds the prepared statements sent in one D1 batch.
export const DEFAULT_MODEL_CATALOG_WRITE_BATCH_SIZE = 100

export interface CloudflareModelCatalogRepositoryOptions {
  readonly writeBatchSize?: number
}

interface SourceRow {
  readonly source: string
  readonly revision: string
  readonly refreshed_at: number
  readonly active_generation: string
}

interface ProviderRow {
  readonly provider_id: string
  readonly name: string
  readonly api: string | null
  readonly npm: string | null
  readonly env_json: string
}

interface ModelRow {
  readonly provider_id: string
  readonly model_id: string
  readonly name: string | null
  readonly metadata_json: string
}

const repositoryError = (message: string, cause: unknown): ModelCatalogRepositoryError =>
  new ModelCatalogRepositoryError({ message, cause })

const batchSizeOf = (value: number | undefined): number => {
  const selected = value ?? DEFAULT_MODEL_CATALOG_WRITE_BATCH_SIZE
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`model catalog writeBatchSize must be a positive integer, got ${selected}`)
  }
  return selected
}

const batchesOf = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: Array<ReadonlyArray<A>> = []
  for (let offset = 0; offset < values.length; offset += size) batches.push(values.slice(offset, offset + size))
  return batches
}

const removeGeneration = (db: D1Database, sourceUrl: string, generation: string): ReturnType<D1Database["batch"]> =>
  db.batch([
    db.prepare("DELETE FROM catalog_models WHERE source_url = ? AND generation = ?").bind(sourceUrl, generation),
    db.prepare("DELETE FROM catalog_providers WHERE source_url = ? AND generation = ?").bind(sourceUrl, generation)
  ])

const parsed = (value: string): unknown => JSON.parse(value) as unknown

const snapshotOf = (
  source: SourceRow,
  providers: ReadonlyArray<ProviderRow>,
  models: ReadonlyArray<ModelRow>
): ModelCatalog => {
  const byProvider = new Map<string, Array<ModelRow>>()
  for (const model of models) {
    const entries = byProvider.get(model.provider_id) ?? []
    entries.push(model)
    byProvider.set(model.provider_id, entries)
  }
  return Schema.decodeUnknownSync(ModelCatalogSchema)({
    source: source.source,
    revision: source.revision,
    refreshedAt: Number(source.refreshed_at),
    status: "cached",
    providers: providers.map((provider) => ({
      id: provider.provider_id,
      name: provider.name,
      ...(provider.api === null ? {} : { api: provider.api }),
      ...(provider.npm === null ? {} : { npm: provider.npm }),
      env: parsed(provider.env_json),
      models: (byProvider.get(provider.provider_id) ?? []).map((model) => ({
        id: model.model_id,
        ...(model.name === null ? {} : { name: model.name }),
        metadata: parsed(model.metadata_json)
      }))
    }))
  })
}

const sourceOf = (db: D1Database, sourceUrl: string): Promise<SourceRow | null> =>
  db.prepare(
    "SELECT source, revision, refreshed_at, active_generation FROM catalog_sources WHERE source_url = ?"
  ).bind(sourceUrl).first<SourceRow>()

const readStored = async (
  db: D1Database,
  sourceUrl: string,
  providerIds?: ReadonlyArray<string>
): Promise<ModelCatalog | undefined> => {
  const source = await sourceOf(db, sourceUrl)
  if (source === null) return undefined
  if (providerIds !== undefined && providerIds.length === 0) return snapshotOf(source, [], [])
  const providerWhere = providerIds === undefined ? "" : ` AND provider_id IN (${providerIds.map(() => "?").join(", ")})`
  const params = providerIds === undefined ? [sourceUrl, source.active_generation] : [sourceUrl, source.active_generation, ...providerIds]
  const [providerResult, modelResult] = await db.batch([
    db.prepare(
      `SELECT provider_id, name, api, npm, env_json FROM catalog_providers WHERE source_url = ? AND generation = ?${providerWhere} ORDER BY ordinal`
    ).bind(...params),
    db.prepare(
      `SELECT provider_id, model_id, name, metadata_json FROM catalog_models WHERE source_url = ? AND generation = ?${providerWhere} ORDER BY provider_ordinal, ordinal`
    ).bind(...params)
  ])
  return snapshotOf(
    source,
    providerResult!.results as unknown as ReadonlyArray<ProviderRow>,
    modelResult!.results as unknown as ReadonlyArray<ModelRow>
  )
}

const writeStored = async (
  db: D1Database,
  sourceUrl: string,
  snapshot: ModelCatalog,
  batchSize: number
): Promise<void> => {
  const previous = await sourceOf(db, sourceUrl)
  const generation = crypto.randomUUID()
  const statements: Array<D1PreparedStatement> = []
  snapshot.providers.forEach((provider, providerOrdinal) => {
    statements.push(db.prepare(
      "INSERT INTO catalog_providers (source_url, generation, ordinal, provider_id, name, api, npm, env_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      sourceUrl,
      generation,
      providerOrdinal,
      provider.id,
      provider.name,
      provider.api ?? null,
      provider.npm ?? null,
      JSON.stringify(provider.env)
    ))
    provider.models.forEach((model, ordinal) => {
      statements.push(db.prepare(
        "INSERT INTO catalog_models (source_url, generation, provider_ordinal, ordinal, provider_id, model_id, name, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        sourceUrl,
        generation,
        providerOrdinal,
        ordinal,
        provider.id,
        model.id,
        model.name ?? null,
        JSON.stringify(model.metadata)
      ))
    })
  })
  try {
    for (const batch of batchesOf(statements, batchSize)) await db.batch([...batch])
    await db.prepare(
      `INSERT INTO catalog_sources (source_url, source, revision, refreshed_at, active_generation) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_url) DO UPDATE SET source = excluded.source, revision = excluded.revision, refreshed_at = excluded.refreshed_at, active_generation = excluded.active_generation`
    ).bind(sourceUrl, snapshot.source, snapshot.revision, snapshot.refreshedAt, generation).run()
  } catch (cause) {
    try {
      await removeGeneration(db, sourceUrl, generation)
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], `catalog generation ${generation} failed and could not be removed`)
    }
    throw cause
  }
  if (previous !== null && previous.active_generation !== generation) {
    await removeGeneration(db, sourceUrl, previous.active_generation)
  }
}

// layerCloudflareModelCatalogRepository stores validated catalog rows in the host's shared D1 binding.
export const layerCloudflareModelCatalogRepository = (
  db: D1Database,
  options: CloudflareModelCatalogRepositoryOptions = {}
): Layer.Layer<ModelCatalogRepository> => {
  const writeBatchSize = batchSizeOf(options.writeBatchSize)
  const read = (sourceUrl: string) => Effect.tryPromise({
    try: () => readStored(db, sourceUrl),
    catch: (cause) => repositoryError(`could not read model catalog snapshot for ${JSON.stringify(sourceUrl)}`, cause)
  })
  return Layer.succeed(ModelCatalogRepository)({
    read,
    readScope: (sourceUrl: string, scope: ModelCatalogScope) => Effect.tryPromise({
      try: async () => {
        const snapshot = await readStored(db, sourceUrl, scope.providers)
        return snapshot === undefined ? undefined : modelCatalogScopeOf(snapshot, scope)
      },
      catch: (cause) => repositoryError(`could not read model catalog scope for ${JSON.stringify(sourceUrl)}`, cause)
    }),
    write: (sourceUrl, snapshot) => Effect.tryPromise({
      try: () => writeStored(db, sourceUrl, snapshot, writeBatchSize),
      catch: (cause) => repositoryError(`could not write model catalog snapshot for ${JSON.stringify(sourceUrl)}`, cause)
    })
  } satisfies ModelCatalogRepositoryService)
}
