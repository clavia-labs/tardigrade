import { Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { DEFAULT_MAX_LOCAL_OBJECT_BYTES, ObjectStorage, sqlObjectStorage, type LocalObjectStorageOptions } from "@clavia/tardigrade-agent"
import { CLOUDFLARE_SQLITE_MAX_OBJECT_BYTES } from "./limits"

// objectStorageFromSqlite retains local objects across DO eviction (test/objects.workers.ts).
export const objectStorageFromSqlite = (storage: DurableObjectStorage, options: LocalObjectStorageOptions = {}) => {
  if ((options.maxObjectBytes ?? DEFAULT_MAX_LOCAL_OBJECT_BYTES) > CLOUDFLARE_SQLITE_MAX_OBJECT_BYTES) {
    throw new RangeError("maxObjectBytes exceeds the Cloudflare SQLite object limit")
  }
  return Layer.effect(ObjectStorage, sqlObjectStorage(options)).pipe(Layer.provide(SqliteClient.layer({ storage })))
}
