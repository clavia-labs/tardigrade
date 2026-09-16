import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { objectKeyOf, objectRefOf } from "./reference"
import { objectCachePolicy, type ObjectCache, type ObjectCacheCapabilities, type ObjectCachePolicy } from "./cache"

// SQL_OBJECT_CACHE_ROW_HEADROOM_BYTES reserves space for fixed-length identity hashes and row metadata (platform/cloudflare/test/objects.workers.ts).
export const SQL_OBJECT_CACHE_ROW_HEADROOM_BYTES = 1024

// sqlObjectCache bounds retained payload bytes; database pages and indexes are outside this budget (platform/bun/src/object-cache.test.ts).
export const sqlObjectCache = (options: {
  readonly namespace: string
  readonly capabilities: ObjectCacheCapabilities
} & Partial<ObjectCachePolicy>) => Effect.gen(function* () {
  const policy = objectCachePolicy(options.capabilities, options)
  const sql = yield* SqlClient.SqlClient
  const namespace = (yield* objectRefOf(new TextEncoder().encode(options.namespace))).digest
  yield* sql`CREATE TABLE IF NOT EXISTS object_cache (
    namespace TEXT NOT NULL, key TEXT NOT NULL, bytes BLOB NOT NULL, used INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
  )`
  yield* sql`CREATE INDEX IF NOT EXISTS object_cache_lru ON object_cache (namespace, used)`
  yield* sql`CREATE TABLE IF NOT EXISTS object_cache_usage (namespace TEXT PRIMARY KEY, bytes INTEGER NOT NULL)`
  const prune = Effect.gen(function* () {
    const usage = yield* sql<{ bytes: number }>`SELECT bytes FROM object_cache_usage WHERE namespace = ${namespace}`
    let retained = Number(usage[0]!.bytes)
    while (retained > policy.maxCacheBytes) {
      const rows = yield* sql<{ key: string; size: number }>`SELECT key, length(bytes) AS size FROM object_cache WHERE namespace = ${namespace} ORDER BY used, key LIMIT 1`
      const row = rows[0]!
      yield* sql`DELETE FROM object_cache WHERE namespace = ${namespace} AND key = ${row.key}`
      retained -= Number(row.size)
    }
    yield* sql`UPDATE object_cache_usage SET bytes = ${retained} WHERE namespace = ${namespace}`
  })
  const nextUse = sql<{ used: number }>`SELECT COALESCE(MAX(used), 0) + 1 AS used FROM object_cache WHERE namespace = ${namespace}`.pipe(
    Effect.map((rows) => Number(rows[0]!.used))
  )
  yield* sql.withTransaction(Effect.gen(function* () {
    yield* sql`DELETE FROM object_cache WHERE namespace = ${namespace} AND (length(bytes) > ${policy.maxCachedObjectBytes} OR length(bytes) = 0)`
    yield* sql`INSERT INTO object_cache_usage (namespace, bytes)
      SELECT ${namespace}, COALESCE(SUM(length(bytes)), 0) FROM object_cache WHERE namespace = ${namespace}
      ON CONFLICT(namespace) DO UPDATE SET bytes = excluded.bytes`
    yield* prune
  }))
  return {
    policy,
    get: (reference) => sql.withTransaction(Effect.gen(function* () {
      const key = objectKeyOf(reference)
      const rows = yield* sql<{ bytes: Uint8Array }>`SELECT bytes FROM object_cache WHERE namespace = ${namespace} AND key = ${key}`
      const bytes = rows[0]?.bytes
      if (bytes !== undefined) {
        const used = yield* nextUse
        yield* sql`UPDATE object_cache SET used = ${used} WHERE namespace = ${namespace} AND key = ${key}`
      }
      return bytes
    })),
    put: (reference, bytes) => {
      if (bytes.byteLength === 0 || bytes.byteLength > policy.maxCachedObjectBytes || bytes.byteLength > policy.maxCacheBytes) return Effect.void
      return sql.withTransaction(Effect.gen(function* () {
        const used = yield* nextUse
        const previous = yield* sql<{ size: number }>`SELECT length(bytes) AS size FROM object_cache WHERE namespace = ${namespace} AND key = ${objectKeyOf(reference)}`
        yield* sql`INSERT INTO object_cache (namespace, key, bytes, used) VALUES (${namespace}, ${objectKeyOf(reference)}, ${bytes}, ${used})
          ON CONFLICT(namespace, key) DO UPDATE SET bytes = excluded.bytes, used = excluded.used`
        yield* sql`UPDATE object_cache_usage SET bytes = bytes + ${bytes.byteLength - Number(previous[0]?.size ?? 0)} WHERE namespace = ${namespace}`
        yield* prune
      }))
    },
    remove: (reference) => sql.withTransaction(Effect.gen(function* () {
      const removed = yield* sql<{ size: number }>`DELETE FROM object_cache WHERE namespace = ${namespace} AND key = ${objectKeyOf(reference)} RETURNING length(bytes) AS size`
      yield* sql`UPDATE object_cache_usage SET bytes = bytes - ${Number(removed[0]?.size ?? 0)} WHERE namespace = ${namespace}`
    }))
  } satisfies ObjectCache
})
