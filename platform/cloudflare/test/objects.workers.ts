import { env, evictDurableObject, runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { ObjectStorage, DEFAULT_MAX_LOCAL_OBJECT_BYTES } from "@clavia/tardigrade-agent"
import { CLOUDFLARE_OBJECT_CACHE_CAPABILITIES, objectStorageFromR2 } from "../src/object-storage/r2"
import type { Env } from "../src/env"
import { objectStorageFromSqlite } from "../src/object-storage/sqlite"

const bucket = (env as Env & { OBJECTS: R2Bucket }).OBJECTS
const open = (prefix: string) => Effect.runPromise(ObjectStorage.pipe(Effect.provide(objectStorageFromR2(bucket, { prefix }))))

const trackReads = () => {
  let reads = 0
  return {
    bucket: { put: bucket.put.bind(bucket), get: (...args: Parameters<R2Bucket["get"]>) => { reads++; return bucket.get(...args) } },
    reads: () => reads
  }
}

test("local SQLite retains objects without R2 or eviction and rejects oversized writes", async () => {
  const stub = (env as Env).THREADS.getByName("local-objects")
  const bytes = new Uint8Array(DEFAULT_MAX_LOCAL_OBJECT_BYTES).fill(4)
  const ref = await runInDurableObject(stub, async (_instance, state) => Effect.runPromise(Effect.gen(function* () {
    const storage = yield* ObjectStorage
    const reference = yield* storage.put(bytes)
    expect(yield* storage.put(new Uint8Array(bytes.length + 1)).pipe(Effect.flip)).toMatchObject({ reason: "TooLarge", actualBytes: bytes.length + 1, maxObjectBytes: bytes.length })
    for (let i = 0; i < 4; i++) yield* storage.put(new Uint8Array(bytes.length).fill(i))
    expect(yield* storage.get(reference)).toEqual(bytes)
    return reference
  }).pipe(Effect.provide(objectStorageFromSqlite(state.storage)))))
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (_instance, state) => {
    expect(() => objectStorageFromSqlite(state.storage, { maxObjectBytes: CLOUDFLARE_OBJECT_CACHE_CAPABILITIES.maxObjectBytes + 1 })).toThrow("Cloudflare SQLite object limit")
    await Effect.runPromise(Effect.gen(function* () {
      const storage = yield* ObjectStorage
      expect(yield* storage.get(ref)).toEqual(bytes)
      expect(yield* storage.put(new Uint8Array(5)).pipe(Effect.flip)).toMatchObject({ reason: "TooLarge", maxObjectBytes: 4 })
    }).pipe(Effect.provide(objectStorageFromSqlite(state.storage, { maxObjectBytes: 4 }))))
  })
})

test("R2-backed storage shares objects across service instances while isolating prefixes", async () => {
  const upload = await open("tenant-a/")
  const inference = await open("tenant-a/")
  const isolated = await open("tenant-b/")
  const bytes = new TextEncoder().encode("abc")
  const reference = await Effect.runPromise(upload.put(bytes))
  expect(await Effect.runPromise(inference.put(bytes))).toEqual(reference)
  expect((await bucket.list({ prefix: "tenant-a/" })).objects.map(object => object.key)).toEqual([
    "tenant-a/sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  ])
  expect(await Effect.runPromise(inference.get(reference))).toEqual(bytes)
  expect(await Effect.runPromise(isolated.get(reference).pipe(Effect.flip))).toMatchObject({ reason: "Missing" })
  expect(await Effect.runPromise(isolated.put(bytes))).toEqual(reference)
  await bucket.delete(`tenant-a/${reference.algorithm}:${reference.digest}`)
  expect(await Effect.runPromise(isolated.get(reference))).toEqual(bytes)
})

test("R2 reads reject bytes overwritten outside the content-addressed adapter", async () => {
  const storage = await open("corrupt/")
  const reference = await Effect.runPromise(storage.put(new Uint8Array([1, 2, 3])))
  await bucket.put(`corrupt/${reference.algorithm}:${reference.digest}`, new Uint8Array([9]))
  const error = await Effect.runPromise(storage.get(reference).pipe(Effect.flip))
  expect(error).toMatchObject({ reason: "Integrity", reference })
})

test("DO cache admits bounded objects, survives eviction, and isolates backing namespaces", async () => {
  const stub = (env as Env).THREADS.getByName("object-cache-persistence")
  const prefix = "cached/"
  const policy = { maxCachedObjectBytes: 16, maxCacheBytes: 32 }
  const reference = await runInDurableObject(stub, async (_instance, state) => {
    const cache = { storage: state.storage, namespace: "objects-bucket", ...policy }
    const tracked = trackReads()
    const layer = objectStorageFromR2(tracked.bucket, { prefix, cache })
    return Effect.runPromise(Effect.gen(function* () {
      const storage = yield* ObjectStorage
      const bytes = new Uint8Array(policy.maxCachedObjectBytes).fill(7)
      const ref = yield* storage.put(bytes)
      expect(yield* storage.get(ref)).toEqual(bytes)
      expect(tracked.reads()).toBe(0)
      const large = new Uint8Array(policy.maxCachedObjectBytes + 1).fill(8)
      const largeRef = yield* storage.put(large)
      expect(yield* storage.get(largeRef)).toEqual(large)
      expect(yield* storage.get(largeRef)).toEqual(large)
      expect(tracked.reads()).toBe(2)
      return ref
    }).pipe(Effect.provide(layer)))
  })
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (_instance, state) => {
    const tracked = trackReads()
    const cache = { storage: state.storage, namespace: "objects-bucket", ...policy }
    await Effect.runPromise(Effect.gen(function* () {
      const storage = yield* ObjectStorage
      expect(yield* storage.get(reference)).toEqual(new Uint8Array(policy.maxCachedObjectBytes).fill(7))
      expect(tracked.reads()).toBe(0)
    }).pipe(Effect.provide(objectStorageFromR2(tracked.bucket, { prefix, cache }))))
    for (const isolated of [
      { prefix: "other-prefix/", cache },
      { prefix, cache: { ...cache, namespace: "other-bucket" } }
    ]) {
      const emptyBucket = { put: bucket.put.bind(bucket), get: () => Promise.resolve(null) }
      const failure = await Effect.runPromise(Effect.gen(function* () {
        return yield* (yield* ObjectStorage).get(reference).pipe(Effect.flip)
      }).pipe(Effect.provide(objectStorageFromR2(emptyBucket, isolated))))
      expect(failure).toMatchObject({ reason: "Missing" })
    }
  })
})

test("DO cache exposes its row capacity and refuses unsupported policy before use", async () => {
  const stub = (env as Env).THREADS.getByName("object-cache-capacity")
  await runInDurableObject(stub, async (_instance, state) => {
    const maxCachedObjectBytes = CLOUDFLARE_OBJECT_CACHE_CAPABILITIES.maxObjectBytes
    const cache = { storage: state.storage, namespace: "capacity", maxCachedObjectBytes }
    const tracked = trackReads()
    expect(() => objectStorageFromR2(bucket, { cache: { ...cache, maxCachedObjectBytes: maxCachedObjectBytes + 1 } })).toThrow("host object cache limit")
    await Effect.runPromise(Effect.gen(function* () {
      const storage = yield* ObjectStorage
      const bytes = new Uint8Array(maxCachedObjectBytes).fill(3)
      const ref = yield* storage.put(bytes)
      expect(yield* storage.get(ref)).toEqual(bytes)
      expect(tracked.reads()).toBe(0)
    }).pipe(Effect.provide(objectStorageFromR2(tracked.bucket, { prefix: "capacity/", cache }))))
  })
})
