import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { objectRefOf } from "./reference"
import { DEFAULT_OBJECT_STORAGE_PREFIX, objectStorageFromKeyValueStore } from "./key-value"
import { ObjectStorage } from "./storage"

const bytes = new TextEncoder().encode("abc")
const keyOf = (digest: string) => `${DEFAULT_OBJECT_STORAGE_PREFIX}sha256:${digest}`

describe("KV object storage", () => {
  test("retries and concurrent uploads reuse one entry, including empty objects", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore
      yield* Effect.gen(function* () {
        const storage = yield* ObjectStorage
        const references = yield* Effect.all([storage.put(bytes), storage.put(bytes)], { concurrency: "unbounded" })
        expect(references[0]).toEqual(references[1])
        expect(yield* storage.put(bytes)).toEqual(references[0])
        expect(yield* kv.size).toBe(1)
        expect(yield* storage.get(references[0]!)).toEqual(bytes)
        const empty = yield* storage.put(new Uint8Array())
        expect(yield* storage.get(empty)).toEqual(new Uint8Array())
      }).pipe(Effect.provide(objectStorageFromKeyValueStore()))
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))
  })

  test("isolates caller mutations and respects the configured prefix", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore
      yield* Effect.gen(function* () {
        const storage = yield* ObjectStorage
        const input = new Uint8Array(bytes)
        const reference = yield* storage.put(input)
        input.fill(0)
        const output = yield* storage.get(reference)
        expect(output).toEqual(bytes)
        output.fill(0)
        expect(yield* storage.get(reference)).toEqual(bytes)
        expect(yield* kv.has(`tenant:sha256:${reference.digest}`)).toBe(true)
        expect(yield* kv.has(keyOf(reference.digest))).toBe(false)
      }).pipe(Effect.provide(objectStorageFromKeyValueStore({ prefix: "tenant:" })))
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))
  })

  test("distinguishes missing objects from corrupted bytes", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore
      yield* Effect.gen(function* () {
        const storage = yield* ObjectStorage
        const reference = yield* objectRefOf(bytes)
        const missing = yield* storage.get(reference).pipe(Effect.flip)
        expect(missing.reason).toBe("Missing")
        yield* kv.set(keyOf(reference.digest), new Uint8Array([0]))
        const corrupt = yield* storage.get(reference).pipe(Effect.flip)
        expect(corrupt.reason).toBe("Integrity")
        expect(corrupt.reference).toEqual(reference)
      }).pipe(Effect.provide(objectStorageFromKeyValueStore()))
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))
  })

  test("preserves backend failures without reporting success or missing content", async () => {
    const cause = new KeyValueStore.KeyValueStoreError({ method: "test", message: "offline" })
    await Effect.runPromise(Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore
      const failing = KeyValueStore.make({
        ...kv,
        set: () => Effect.fail(cause),
        getUint8Array: () => Effect.fail(cause)
      })
      yield* Effect.gen(function* () {
        const storage = yield* ObjectStorage
        const reference = yield* objectRefOf(bytes)
        const write = yield* storage.put(bytes).pipe(Effect.flip)
        expect(write.reason).toBe("Write")
        expect(write.cause).toBe(cause)
        const read = yield* storage.get(reference).pipe(Effect.flip)
        expect(read.reason).toBe("Read")
        expect(read.cause).toBe(cause)
        expect(yield* kv.size).toBe(0)
      }).pipe(
        Effect.provide(objectStorageFromKeyValueStore()),
        Effect.provideService(KeyValueStore.KeyValueStore, failing)
      )
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))
  })
})
