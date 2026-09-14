import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { ObjectStorage, objectStorageFromKeyValueStore } from "@clavia/tardigrade-agent"

// objectStorageFromSqlite shares objects through the supplied database across host restarts (e2e/host/objects.test.ts).
export const objectStorageFromSqlite = (
  config: SqliteClient.SqliteClientConfig,
  options: KeyValueStore.LayerSqlOptions & { readonly prefix?: string } = {}
): Layer.Layer<ObjectStorage> => objectStorageFromKeyValueStore(options).pipe(Layer.provide(
  KeyValueStore.layerSql(options).pipe(Layer.provide(SqliteClient.layer(config)))
))
