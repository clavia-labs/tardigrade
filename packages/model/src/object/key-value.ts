import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { makeObjectStorage, ObjectStorage } from "./storage"

export const DEFAULT_OBJECT_STORAGE_PREFIX = "objects:"

// objectStorageFromKeyValueStore isolates object keys under a configurable prefix (key-value.test.ts).
export const objectStorageFromKeyValueStore = (
  options: { readonly prefix?: string } = {}
): Layer.Layer<ObjectStorage, never, KeyValueStore.KeyValueStore> =>
  Layer.effect(ObjectStorage, Effect.gen(function* () {
    const store = KeyValueStore.prefix(yield* KeyValueStore.KeyValueStore, options.prefix ?? DEFAULT_OBJECT_STORAGE_PREFIX)
    return makeObjectStorage({ read: store.getUint8Array, write: store.set })
  }))
