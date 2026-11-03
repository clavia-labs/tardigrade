import { Effect, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { makeObjectStorage, ObjectStorage, ObjectStorageError } from "./storage"
import { objectKeyOf, objectRefOf } from "./reference"
import { objectStreamConfig, objectUploadId, type ObjectUpload } from "./stream"

export const DEFAULT_MAX_LOCAL_OBJECT_BYTES = 1_500_000

export interface LocalObjectStorageOptions {
  readonly namespace?: string
  readonly maxObjectBytes?: number
  readonly chunkBytes?: number
}

// sqlObjectStorage retains objects without eviction and rejects oversized writes.
export const sqlObjectStorage = (options: LocalObjectStorageOptions = {}) => {
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_LOCAL_OBJECT_BYTES
  const policy = objectStreamConfig({ ...options, maxObjectBytes })
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const namespace = (yield* objectRefOf(new TextEncoder().encode(options.namespace ?? "objects"))).digest
    yield* sql`CREATE TABLE IF NOT EXISTS object_storage (
      namespace TEXT NOT NULL, key TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(namespace, key)
    )`
    yield* sql`CREATE TABLE IF NOT EXISTS object_storage_manifests (
      namespace TEXT NOT NULL, key TEXT NOT NULL, byte_size INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
      PRIMARY KEY(namespace, key)
    )`
    yield* sql`CREATE TABLE IF NOT EXISTS object_storage_chunks (
      namespace TEXT NOT NULL, key TEXT NOT NULL, ordinal INTEGER NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY(namespace, key, ordinal)
    )`
    yield* sql`CREATE TABLE IF NOT EXISTS object_storage_uploads (
      namespace TEXT NOT NULL, upload_id TEXT NOT NULL, ordinal INTEGER NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY(namespace, upload_id, ordinal)
    )`
    const upload = objectUploadId.pipe(Effect.map(uploadId => {
      let ordinal = 0
      return {
        write: bytes => sql`INSERT INTO object_storage_uploads (namespace, upload_id, ordinal, bytes) VALUES (${namespace}, ${uploadId}, ${ordinal++}, ${bytes})`.pipe(Effect.asVoid),
        commit: object => sql.withTransaction(Effect.gen(function* () {
          const key = objectKeyOf(object.object)
          const inserted = yield* sql<{ key: string }>`INSERT INTO object_storage_manifests (namespace, key, byte_size, chunk_count) VALUES (${namespace}, ${key}, ${object.byteSize}, ${ordinal}) ON CONFLICT(namespace, key) DO NOTHING RETURNING key`
          if (inserted.length) yield* sql`INSERT INTO object_storage_chunks (namespace, key, ordinal, bytes) SELECT namespace, ${key}, ordinal, bytes FROM object_storage_uploads WHERE namespace = ${namespace} AND upload_id = ${uploadId}`
        })),
        abort: sql`DELETE FROM object_storage_uploads WHERE namespace = ${namespace} AND upload_id = ${uploadId}`.pipe(Effect.asVoid),
      } satisfies ObjectUpload<SqlError>
    }))
    const backing = makeObjectStorage({
      upload,
      read: key => Effect.gen(function* () {
        const [manifest] = yield* sql<{ byte_size: number; chunk_count: number }>`SELECT byte_size, chunk_count FROM object_storage_manifests WHERE namespace = ${namespace} AND key = ${key}`
        if (!manifest) {
          const rows = yield* sql<{ bytes: Uint8Array }>`SELECT bytes FROM object_storage WHERE namespace = ${namespace} AND key = ${key}`
          return rows[0]?.bytes
        }
        const chunks = yield* sql<{ ordinal: number; bytes: Uint8Array }>`SELECT ordinal, bytes FROM object_storage_chunks WHERE namespace = ${namespace} AND key = ${key} ORDER BY ordinal`
        return yield* Effect.try({ try: () => {
          if (!Number.isSafeInteger(manifest.byte_size) || manifest.byte_size < 0 || chunks.length !== manifest.chunk_count) throw new Error("Invalid stored object manifest")
          const bytes = new Uint8Array(manifest.byte_size)
          let offset = 0
          for (const [index, chunk] of chunks.entries()) {
            if (chunk.ordinal !== index || offset + chunk.bytes.byteLength > bytes.byteLength) throw new Error("Invalid stored object chunks")
            bytes.set(chunk.bytes, offset)
            offset += chunk.bytes.byteLength
          }
          if (offset !== bytes.byteLength) throw new Error("Stored object byte size differs from its manifest")
          return bytes
        }, catch: cause => new ObjectStorageError({ reason: "Integrity", message: "Stored object chunks are invalid", cause }) })
      }),
      write: (key, bytes) => sql`INSERT INTO object_storage(namespace, key, bytes) VALUES (${namespace}, ${key}, ${bytes})
        ON CONFLICT(namespace, key) DO UPDATE SET bytes = excluded.bytes`.pipe(Effect.asVoid)
    }, policy)
    return ObjectStorage.of({
      get: backing.get,
      putStream: backing.putStream!,
      put: bytes => {
        if (bytes.byteLength <= maxObjectBytes) {
          if (bytes.byteLength <= policy.chunkBytes) return backing.put(bytes)
          return Effect.suspend(() => backing.putStream!(Stream.make(new Uint8Array(bytes)))).pipe(Effect.map(result => result.object))
        }
        return Effect.gen(function* () {
          const actualBytes = bytes.byteLength
          const reference = yield* objectRefOf(bytes)
          return yield* new ObjectStorageError({ reason: "TooLarge", reference, actualBytes, maxObjectBytes,
            message: `Object has ${actualBytes} bytes; local storage allows ${maxObjectBytes}` })
        })
      },
    })
  })
}
