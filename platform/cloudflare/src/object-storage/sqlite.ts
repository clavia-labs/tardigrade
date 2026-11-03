import { Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { DEFAULT_OBJECT_STREAM_CHUNK_BYTES, ObjectStorage, sqlObjectStorage, type LocalObjectStorageOptions } from "@clavia/tardigrade-store"
import { CLOUDFLARE_SQLITE_MAX_OBJECT_BYTES } from "./limits"

// objectStorageFromSqlite retains local objects across DO eviction (test/objects.workers.ts).
export const objectStorageFromSqlite = (storage: DurableObjectStorage, options: LocalObjectStorageOptions = {}) => {
  if ((options.chunkBytes ?? DEFAULT_OBJECT_STREAM_CHUNK_BYTES) > CLOUDFLARE_SQLITE_MAX_OBJECT_BYTES) {
    throw new RangeError("chunkBytes exceeds the Cloudflare SQLite object limit")
  }
  return Layer.effect(ObjectStorage, sqlObjectStorage(options)).pipe(Layer.provide(SqliteClient.layer({ storage })))
}
