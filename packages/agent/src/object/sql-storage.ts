import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { makeObjectStorage, ObjectStorage, ObjectStorageError } from "./storage"
import { objectRefOf } from "./reference"

export const DEFAULT_MAX_LOCAL_OBJECT_BYTES = 1_500_000

export interface LocalObjectStorageOptions {
  readonly namespace?: string
  readonly maxObjectBytes?: number
}

// sqlObjectStorage retains objects without eviction and rejects oversized writes (e2e/host/objects.test.ts).
export const sqlObjectStorage = (options: LocalObjectStorageOptions = {}) => {
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_LOCAL_OBJECT_BYTES
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 0) throw new RangeError("maxObjectBytes must be a non-negative safe integer")
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const namespace = (yield* objectRefOf(new TextEncoder().encode(options.namespace ?? "objects"))).digest
    yield* sql`CREATE TABLE IF NOT EXISTS object_storage (
      namespace TEXT NOT NULL, key TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(namespace, key)
    )`
    const backing = makeObjectStorage({
      read: (key) => sql<{ bytes: Uint8Array }>`SELECT bytes FROM object_storage WHERE namespace = ${namespace} AND key = ${key}`.pipe(
        Effect.map(rows => rows[0]?.bytes)
      ),
      write: (key, bytes) => sql`INSERT INTO object_storage(namespace, key, bytes) VALUES (${namespace}, ${key}, ${bytes})
        ON CONFLICT(namespace, key) DO UPDATE SET bytes = excluded.bytes`.pipe(Effect.asVoid)
    })
    return ObjectStorage.of({
      get: backing.get,
      put: (bytes) => bytes.byteLength <= maxObjectBytes ? backing.put(bytes) : Effect.gen(function* () {
        const actualBytes = bytes.byteLength
        const reference = yield* objectRefOf(bytes)
        return yield* new ObjectStorageError({ reason: "TooLarge", reference, actualBytes, maxObjectBytes,
          message: `Object has ${actualBytes} bytes; local storage allows ${maxObjectBytes}` })
      })
    })
  })
}
