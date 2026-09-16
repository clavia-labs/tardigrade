import { Effect, Layer } from "effect"
import { cachedObjectStorage, makeObjectStorage, objectCachePolicy, ObjectStorage, sqlObjectCache, type ObjectCachePolicy } from "@clavia/tardigrade-agent"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { CLOUDFLARE_OBJECT_CACHE_CAPABILITIES } from "./limits"
export { CLOUDFLARE_OBJECT_CACHE_CAPABILITIES, CLOUDFLARE_SQLITE_MAX_ROW_BYTES } from "./limits"

export const DEFAULT_R2_OBJECT_PREFIX = "objects/"

export interface R2ObjectCacheOptions extends Partial<ObjectCachePolicy> {
  readonly storage: DurableObjectStorage
  // namespace identifies the backing bucket within this DO; prefixes remain isolated (test/objects.workers.ts).
  readonly namespace: string
}

// objectStorageFromR2 shares content-addressed objects within the supplied bucket and prefix (test/objects.workers.ts).
export const objectStorageFromR2 = (
  bucket: Pick<R2Bucket, "get" | "put">,
  options: { readonly prefix?: string; readonly cache?: R2ObjectCacheOptions } = {}
): Layer.Layer<ObjectStorage> => {
  const prefix = options.prefix ?? DEFAULT_R2_OBJECT_PREFIX
  const backing = makeObjectStorage({
    read: (key) => Effect.tryPromise(async () => {
      const object = await bucket.get(prefix + key)
      return object === null ? undefined : new Uint8Array(await object.arrayBuffer())
    }),
    write: (key, bytes) => Effect.tryPromise(async () => {
      await bucket.put(prefix + key, bytes)
    })
  })
  if (options.cache === undefined) return Layer.succeed(ObjectStorage, backing)
  const cache = options.cache
  objectCachePolicy(CLOUDFLARE_OBJECT_CACHE_CAPABILITIES, cache)
  return Layer.effect(ObjectStorage, sqlObjectCache({ ...cache,
    namespace: JSON.stringify([cache.namespace, prefix]), capabilities: CLOUDFLARE_OBJECT_CACHE_CAPABILITIES
  }).pipe(Effect.map((local) => cachedObjectStorage(backing, local)),
    Effect.catch((cause) => Effect.logWarning("Object cache initialization failed", cause).pipe(Effect.as(backing)))
  )).pipe(Layer.provide(SqliteClient.layer({ storage: cache.storage })))
}
