import { make as makeState, type Storage, type Instance } from "./document"

// make exposes scoped documents and encoded staging entries without node representation details (test/transactions.test.ts; test/collections/tree.test.ts; test/references.test.ts).
export const make: (storage: Storage) => Instance = makeState
export { isFrozenJson, DEFAULT_PAGE_ITEMS, DEFAULT_FANOUT, DEFAULT_LEAF_BYTES, DEFAULT_TAIL_BYTES, DEFAULT_OBJECT_PAGE_ITEMS } from "./storage/nodes"
export type { Json, Path, Options } from "./storage/nodes"
export { treeSchema } from "./document"
export type { MerkleTree, Mutations, Selection, Storage, Instance, PreparedBatch } from "./document"
export { EncodedReference, selectionValueReference, encodeReference, decodeReference } from "./value"
export type { ValueReference, ValueRange, View } from "./value"
export { GroveError, DEFAULT_READ_CACHE_BYTES } from "./session/reader"
export type { ReaderOptions } from "./session/reader"

export { value, isValue, tree, appendOnly, keyValue, collectionSchema } from "./schema"
export type { Tree, AppendOnly, KeyValue, CollectionSchema } from "./schema"

export { DEFAULT_ROW_BATCH_ITEMS } from "./collections/append-only"
export type { RowStorage, LogBatch, LogWrite, LogSpan } from "./collections/append-only"

export type { MapStorage, MapEntry, MapSpan, MapChange, MapWrite, MapBatch } from "./collections/key-value"

export { bindValue, ValueState } from "./collections/value"
export { incrementalValidator, invalid } from "./session/validation"
