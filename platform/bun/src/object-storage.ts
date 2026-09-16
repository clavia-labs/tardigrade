import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Layer } from "effect"
import { ObjectStorage, sqlObjectStorage, type LocalObjectStorageOptions } from "@clavia/tardigrade-agent"

// objectStorageFromSqlite shares objects through the supplied database across host restarts (e2e/host/objects.test.ts).
export const objectStorageFromSqlite = (
  config: SqliteClient.SqliteClientConfig,
  options: LocalObjectStorageOptions = {}
) => Layer.effect(ObjectStorage, sqlObjectStorage(options)).pipe(Layer.provide(SqliteClient.layer(config)))
