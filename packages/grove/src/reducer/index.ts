import type { Definition, Json, Materialization, Reference } from "./state"
import type { Sqlite, Transaction } from "./storage"

export { makeSync, DEFAULT_CHUNK_BYTES, MIN_CHUNK_BYTES } from "./sqlite"
export { DEFAULT_PACK_BYTES } from "./json"
export type { Options } from "./sqlite"

export type { Definition, Json, Materialization, Record, Reference, Version } from "./state"
export type { Parameter, Row, Sqlite, Transaction } from "./storage"

// Stats counts attempted work cumulatively, including rolled-back writes (test/reducer/complexity.test.ts).
export interface Stats {
  readonly stagedVersions: number
  readonly visitedValues: number
  readonly arrayEntriesVisited: number
  readonly sqlStatements: number
  readonly cellWrites: number
  readonly encodedBytes: number
}

// Grove coordinates staged materialisations, durable snapshot ownership and synchronous transactions.
export interface Grove {
  readonly materialize: <State extends Json, Event, Metadata>(definition: Definition<State, Event, Metadata>) => Materialization<State, Event, Metadata>
  readonly transaction: <Value>(work: (tx: Transaction) => Value) => Value
  readonly retain: <State extends Json>(tx: Transaction, owner: string, reference: Reference<State>) => void
  readonly release: <State extends Json>(tx: Transaction, owner: string, options: { readonly expected: Reference<State> }) => void
  readonly discard: (keep?: readonly Reference[]) => void
  readonly collect: (keep?: readonly Reference[]) => void
  readonly stats: () => Stats
}

// MakeSync is the synchronous store constructor.
export type MakeSync = (sqlite: Sqlite, options: import("./sqlite").Options) => Grove

export { selectEach, rememberState } from "./adapter"
export type { PlainVersion, PlainOptions, PlainBinding } from "./adapter"
