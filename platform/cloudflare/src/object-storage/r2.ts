import { ioRetryPolicy, retryIo, type IoRetryPolicy } from "@clavia/tardigrade-deprecated-host/retry"
import { Effect, Layer } from "effect"
import { cachedObjectStorage, makeObjectStorage, objectCachePolicy, ObjectStorage, sqlObjectCache, type ObjectCachePolicy } from "@clavia/tardigrade-model/object"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { CLOUDFLARE_OBJECT_CACHE_CAPABILITIES } from "./limits"
import type { R2StorageError } from "../layers/r2-error"
import { makeR2Storage, type R2StorageOptions } from "../layers/r2"
export { CLOUDFLARE_OBJECT_CACHE_CAPABILITIES, CLOUDFLARE_SQLITE_MAX_ROW_BYTES } from "./limits"

export { DEFAULT_IO_RETRY_POLICY, IoTimeoutError, type IoRetryPolicy } from "@clavia/tardigrade-deprecated-host/retry"

export const DEFAULT_R2_OBJECT_PREFIX = "objects/"

export interface R2ObjectCacheOptions extends Partial<ObjectCachePolicy> {
  readonly storage: DurableObjectStorage
  // bucketNamespace identifies the backing bucket within this DO; distinct buckets require distinct names (test/objects.workers.ts).
  readonly bucketNamespace: string
}

export interface R2ObjectStorageOptions extends R2StorageOptions {
  readonly prefix?: string
  readonly cache?: R2ObjectCacheOptions
  // retry overrides DEFAULT_IO_RETRY_POLICY; false disables retries and their timeouts.
  readonly retry?: false | Partial<IoRetryPolicy>
}

// objectStorageFromR2 shares content-addressed objects within the supplied bucket and prefix (test/objects.workers.ts).
export const objectStorageFromR2 = (
  bucket: Pick<R2Bucket, "get" | "put">,
  options: R2ObjectStorageOptions = {}
): Layer.Layer<ObjectStorage> => {
  const prefix = options.prefix ?? DEFAULT_R2_OBJECT_PREFIX
  const storage = makeR2Storage(bucket, options)
  const policy = options.retry === false ? false : ioRetryPolicy(options.retry)
  const retry = <A>(effect: Effect.Effect<A, R2StorageError>, operation: string) =>
    policy === false ? effect : retryIo(effect, { operation, classifyError: error => error, policy })
  const backing = makeObjectStorage({
    read: (key) => retry(storage.read(prefix + key), "R2.read"),
    write: (key, bytes) => retry(storage.write(prefix + key, bytes), "R2.write")
  })
  if (options.cache === undefined) return Layer.succeed(ObjectStorage, backing)
  const cache = options.cache
  objectCachePolicy(CLOUDFLARE_OBJECT_CACHE_CAPABILITIES, cache)
  return Layer.effect(ObjectStorage, sqlObjectCache({ ...cache,
    namespace: JSON.stringify([cache.bucketNamespace, prefix]), capabilities: CLOUDFLARE_OBJECT_CACHE_CAPABILITIES
  }).pipe(Effect.map((local) => cachedObjectStorage(backing, local)),
    Effect.catch((cause) => Effect.logWarning("Object cache initialization failed", cause).pipe(Effect.as(backing)))
  )).pipe(Layer.provide(SqliteClient.layer({ storage: cache.storage })))
}
