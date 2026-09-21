import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { objectRefOf, sqlObjectCache } from "@clavia/tardigrade-agent"

test("SQL cache enforces byte budgets, LRU order, namespace isolation, and reopened policy", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const options = { namespace: "a", capabilities: { maxObjectBytes: 100 }, maxCachedObjectBytes: 4, maxCacheBytes: 6 }
    const cache = yield* sqlObjectCache(options)
    const other = yield* sqlObjectCache({ ...options, namespace: "b" })
    const bytes = [new Uint8Array([1, 1, 1]), new Uint8Array([2, 2, 2]), new Uint8Array([3, 3, 3])]
    const refs = yield* Effect.forEach(bytes, objectRefOf)
    yield* cache.put(refs[0]!, bytes[0]!)
    yield* cache.put(refs[1]!, bytes[1]!)
    yield* cache.get(refs[0]!)
    yield* cache.put(refs[2]!, bytes[2]!)
    expect(yield* cache.get(refs[1]!)).toBeUndefined()
    expect(yield* cache.get(refs[0]!)).toEqual(bytes[0])
    expect(yield* other.get(refs[0]!)).toBeUndefined()
    yield* other.put(refs[1]!, bytes[1]!)
    yield* Effect.all(Array.from({ length: 8 }, () => cache.put(refs[0]!, bytes[0]!)), { concurrency: "unbounded" })
    expect(yield* cache.get(refs[2]!)).toEqual(bytes[2])
    expect(yield* cache.get(refs[0]!)).toEqual(bytes[0])
    expect(yield* other.get(refs[1]!)).toEqual(bytes[1])
    const oversized = new Uint8Array(5)
    const ref = yield* objectRefOf(oversized)
    yield* cache.put(ref, oversized)
    expect(yield* cache.get(ref)).toBeUndefined()
    const reopened = yield* sqlObjectCache({ ...options, maxCacheBytes: 3 })
    expect(yield* reopened.get(refs[0]!)).toEqual(bytes[0])
    expect(yield* reopened.get(refs[2]!)).toBeUndefined()
    yield* sqlObjectCache({ ...options, maxCachedObjectBytes: 2 })
    expect(yield* reopened.get(refs[0]!)).toBeUndefined()
    expect(yield* other.get(refs[1]!)).toEqual(bytes[1])
    yield* other.remove(refs[1]!)
    yield* other.remove(refs[1]!)
    yield* other.put(refs[0]!, bytes[0]!)
    yield* other.put(refs[2]!, bytes[2]!)
    expect(yield* other.get(refs[0]!)).toEqual(bytes[0])
    expect(yield* other.get(refs[2]!)).toEqual(bytes[2])
    const disabled = yield* sqlObjectCache({ ...options, namespace: "b", maxCacheBytes: 0 })
    yield* disabled.put(refs[0]!, bytes[0]!)
    expect(yield* disabled.get(refs[0]!)).toBeUndefined()
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))
})
