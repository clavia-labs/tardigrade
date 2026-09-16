import { expect, test } from "bun:test"
import { Effect } from "effect"
import { cachedObjectStorage, objectCachePolicy, type ObjectCache } from "./cache"
import { objectKeyOf } from "./reference"
import { makeObjectStorage } from "./storage"

const fixture = () => {
  const durable = new Map<string, Uint8Array>()
  const local = new Map<string, Uint8Array>()
  let unavailable = false
  let cacheFailed = false
  let reads = 0
  const backing = makeObjectStorage({
    read: (key) => Effect.try(() => { reads++; if (unavailable) throw new Error("offline"); return durable.get(key) }),
    write: (key, bytes) => Effect.try(() => { if (unavailable) throw new Error("offline"); durable.set(key, bytes) })
  })
  const cache: ObjectCache = {
    policy: objectCachePolicy({ maxObjectBytes: 4 }, { maxCachedObjectBytes: 4, maxCacheBytes: 8 }),
    get: (ref) => Effect.try(() => { if (cacheFailed) throw new Error("cache failed"); return local.get(objectKeyOf(ref)) }),
    put: (ref, bytes) => Effect.try(() => {
      expect(durable.has(objectKeyOf(ref))).toBe(true)
      if (cacheFailed) throw new Error("cache failed")
      local.set(objectKeyOf(ref), bytes)
    }),
    remove: (ref) => Effect.sync(() => { local.delete(objectKeyOf(ref)) })
  }
  return { storage: cachedObjectStorage(backing, cache), durable, local, reads: () => reads,
    offline: () => { unavailable = true }, failCache: () => { cacheFailed = true } }
}

test("durable persistence precedes caching and failed writes publish no local copy", async () => {
  const f = fixture()
  const bytes = new Uint8Array([1, 2])
  const ref = await Effect.runPromise(f.storage.put(bytes))
  bytes.fill(9)
  f.offline()
  const read = await Effect.runPromise(f.storage.get(ref))
  expect(read).toEqual(new Uint8Array([1, 2]))
  read.fill(8)
  expect(await Effect.runPromise(f.storage.get(ref))).toEqual(new Uint8Array([1, 2]))
  expect(f.reads()).toBe(0)
  await expect(Effect.runPromise(f.storage.put(new Uint8Array([3])))).rejects.toThrow("Object write failed")
  expect(f.local.size).toBe(1)
})

test("misses warm the cache while oversized objects bypass it on writes and reads", async () => {
  const f = fixture()
  const small = new Uint8Array([1, 2, 3, 4])
  const large = new Uint8Array(5)
  const ref = await Effect.runPromise(f.storage.put(small))
  f.local.clear()
  const loaded = await Effect.runPromise(f.storage.get(ref))
  expect(loaded).toEqual(small)
  loaded.fill(9)
  expect(await Effect.runPromise(f.storage.get(ref))).toEqual(small)
  expect(f.reads()).toBe(1)
  const big = await Effect.runPromise(f.storage.put(large))
  expect(await Effect.runPromise(f.storage.get(big))).toEqual(large)
  expect(await Effect.runPromise(f.storage.get(big))).toEqual(large)
  expect(f.reads()).toBe(3)
  expect([...f.local.keys()]).toEqual([objectKeyOf(ref)])
})

test("cache failures and corruption cannot replace verified backing-store bytes", async () => {
  const f = fixture()
  const bytes = new Uint8Array([1, 2, 3])
  const ref = await Effect.runPromise(f.storage.put(bytes))
  f.local.set(objectKeyOf(ref), new Uint8Array([9]))
  expect(await Effect.runPromise(f.storage.get(ref))).toEqual(bytes)
  expect(f.local.get(objectKeyOf(ref))).toEqual(bytes)
  f.failCache()
  expect(await Effect.runPromise(f.storage.put(bytes))).toEqual(ref)
  expect(await Effect.runPromise(f.storage.get(ref))).toEqual(bytes)
  f.durable.set(objectKeyOf(ref), new Uint8Array([9]))
  expect(await Effect.runPromise(f.storage.get(ref).pipe(Effect.flip))).toMatchObject({ reason: "Integrity" })
})

test("cache policy distinguishes configurable admission from host capacity", () => {
  expect(objectCachePolicy({ maxObjectBytes: 2_000_000 })).toEqual({ maxCachedObjectBytes: 1_500_000, maxCacheBytes: 32_000_000 })
  expect(objectCachePolicy({ maxObjectBytes: 8 }, { maxCachedObjectBytes: 8, maxCacheBytes: 0 }).maxCacheBytes).toBe(0)
  expect(() => objectCachePolicy({ maxObjectBytes: 8 }, { maxCachedObjectBytes: 9 })).toThrow("host object cache limit")
  for (const value of [-1, 1.5, NaN, Infinity]) {
    expect(() => objectCachePolicy({ maxObjectBytes: 8 }, { maxCachedObjectBytes: value })).toThrow()
    expect(() => objectCachePolicy({ maxObjectBytes: 8 }, { maxCachedObjectBytes: 8, maxCacheBytes: value })).toThrow()
  }
})
