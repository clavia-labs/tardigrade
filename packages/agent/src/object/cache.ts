import { Effect } from "effect"
import { objectRefOf, type ObjectRef } from "./reference"
import { ObjectStorage } from "./storage"

export const DEFAULT_MAX_CACHED_OBJECT_BYTES = 1_500_000
export const DEFAULT_MAX_OBJECT_CACHE_BYTES = 32_000_000

export interface ObjectCachePolicy {
  readonly maxCachedObjectBytes: number
  readonly maxCacheBytes: number
}

export interface ObjectCacheCapabilities {
  readonly maxObjectBytes: number
}

// ObjectCache owns atomic byte accounting and LRU eviction within its namespace (platform/bun/src/object-cache.test.ts).
export interface ObjectCache<E = Error> {
  readonly policy: ObjectCachePolicy
  readonly get: (reference: ObjectRef) => Effect.Effect<Uint8Array | undefined, E>
  readonly put: (reference: ObjectRef, bytes: Uint8Array) => Effect.Effect<void, E>
  readonly remove: (reference: ObjectRef) => Effect.Effect<void, E>
}

// objectCachePolicy rejects policies exceeding the host's object capacity (cache.test.ts).
export const objectCachePolicy = (capabilities: ObjectCacheCapabilities, options: Partial<ObjectCachePolicy> = {}): ObjectCachePolicy => {
  const policy = {
    maxCachedObjectBytes: options.maxCachedObjectBytes ?? DEFAULT_MAX_CACHED_OBJECT_BYTES,
    maxCacheBytes: options.maxCacheBytes ?? DEFAULT_MAX_OBJECT_CACHE_BYTES
  }
  for (const value of [capabilities.maxObjectBytes, policy.maxCachedObjectBytes, policy.maxCacheBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Object cache limits must be non-negative safe integers")
  }
  if (policy.maxCachedObjectBytes > capabilities.maxObjectBytes) throw new RangeError("maxCachedObjectBytes exceeds the host object cache limit")
  return policy
}

// cachedObjectStorage publishes references only after backing-store persistence; cache failures preserve availability (cache.test.ts).
export const cachedObjectStorage = <E>(backing: typeof ObjectStorage.Service, cache: ObjectCache<E>): typeof ObjectStorage.Service => {
  const attempt = <A>(operation: Effect.Effect<A, E>) => operation.pipe(
    Effect.catch((cause) => Effect.logWarning("Object cache operation failed", cause).pipe(Effect.as(undefined)))
  )
  const admit = (reference: ObjectRef, bytes: Uint8Array) => bytes.byteLength > 0
    && bytes.byteLength <= cache.policy.maxCachedObjectBytes && bytes.byteLength <= cache.policy.maxCacheBytes
    ? attempt(cache.put(reference, new Uint8Array(bytes))).pipe(Effect.asVoid) : Effect.void
  return ObjectStorage.of({
    put: (bytes) => Effect.gen(function* () {
      const snapshot = new Uint8Array(bytes)
      const reference = yield* backing.put(snapshot)
      yield* admit(reference, snapshot)
      return reference
    }),
    get: (reference) => Effect.gen(function* () {
      const cached = yield* attempt(cache.get(reference))
      if (cached !== undefined) {
        const snapshot = new Uint8Array(cached)
        const actual = yield* objectRefOf(snapshot)
        if (actual.algorithm === reference.algorithm && actual.digest === reference.digest) return snapshot
        yield* Effect.logWarning("Object cache integrity check failed", reference)
        yield* attempt(cache.remove(reference))
      }
      const bytes = yield* backing.get(reference)
      yield* admit(reference, bytes)
      return bytes
    })
  })
}
