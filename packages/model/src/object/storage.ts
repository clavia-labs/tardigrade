import { ObjectStorage as SharedObjectStorage } from "@clavia/tardigrade-store"
import { persistContent, resolveContent } from "./content-storage"

export { ObjectStorageError, makeObjectStorage, type ObjectUrlOptions } from "@clavia/tardigrade-store"
export { ObjectReadConcurrency, DEFAULT_OBJECT_READ_CONCURRENCY } from "./content-storage"

export type ObjectStorage = SharedObjectStorage

// ObjectStorage retains model content helpers on the shared service (packages/tardie/src/store.test.ts).
export const ObjectStorage = Object.assign(SharedObjectStorage, { persist: persistContent, resolve: resolveContent })
