import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { ModelCatalog as ModelCatalogSchema, type ModelCatalog } from "@clavia/tardigrade-client/contract"
import {
  ModelCatalogRepository,
  ModelCatalogRepositoryError,
  type ModelCatalogRepositoryService
} from "@clavia/tardigrade-server/catalog-store"

// DEFAULT_MODEL_CATALOG_TABLE is the actor-storage table used when a repository does not select another table.
export const DEFAULT_MODEL_CATALOG_TABLE = "model_catalog"

export interface CloudflareModelCatalogRepositoryOptions {
  readonly table?: string
}

const tableOf = (table: string | undefined): string => {
  const selected = table ?? DEFAULT_MODEL_CATALOG_TABLE
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(selected)) {
    throw new Error(`model catalog table is not a SQL identifier: ${JSON.stringify(selected)}`)
  }
  return selected
}

const repositoryError = (message: string, cause: unknown): ModelCatalogRepositoryError =>
  new ModelCatalogRepositoryError({ message, cause })

const decodeSnapshot = (sourceUrl: string, encoded: string): Effect.Effect<ModelCatalog, ModelCatalogRepositoryError> =>
  Effect.try({
    try: () => JSON.parse(encoded) as unknown,
    catch: (cause) => repositoryError(`model catalog snapshot for ${JSON.stringify(sourceUrl)} is invalid`, cause)
  }).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(ModelCatalogSchema)(raw).pipe(
      Effect.mapError((cause) => repositoryError(`model catalog snapshot for ${JSON.stringify(sourceUrl)} is invalid`, cause))
    )),
    Effect.map((snapshot) => ({ ...snapshot, status: "cached" as const }))
  )

// layerCloudflareModelCatalogRepository persists validated snapshots beside the actor log.
export const layerCloudflareModelCatalogRepository = (
  storage: DurableObjectStorage,
  options: CloudflareModelCatalogRepositoryOptions = {}
): Layer.Layer<ModelCatalogRepository> => {
  const table = tableOf(options.table)
  const make = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${table} (
        source_url TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL
      ) WITHOUT ROWID`
    )
    return {
      read: (sourceUrl) => sql.unsafe<{ readonly source_url: string; readonly snapshot: string }>(
        `SELECT source_url, snapshot FROM ${table} WHERE source_url = ?`,
        [sourceUrl]
      ).pipe(
        Effect.mapError((cause) => repositoryError(`could not read model catalog snapshot for ${JSON.stringify(sourceUrl)}`, cause)),
        Effect.flatMap((rows) => rows[0] === undefined
          ? Effect.as(Effect.void, undefined as ModelCatalog | undefined)
          : decodeSnapshot(sourceUrl, rows[0].snapshot))
      ),
      write: (sourceUrl, snapshot) => sql.unsafe(
        `INSERT INTO ${table} (source_url, snapshot) VALUES (?, ?)
         ON CONFLICT(source_url) DO UPDATE SET snapshot = excluded.snapshot`,
        [sourceUrl, JSON.stringify(snapshot)]
      ).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => repositoryError(`could not write model catalog snapshot for ${JSON.stringify(sourceUrl)}`, cause))
      )
    } satisfies ModelCatalogRepositoryService
  }).pipe(Effect.orDie)
  return Layer.effect(ModelCatalogRepository, make).pipe(
    Layer.provide(SqliteClient.layer({ storage }).pipe(Layer.orDie))
  )
}
