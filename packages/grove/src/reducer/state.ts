import type { Schema } from "effect"
import type { Transaction } from "./storage"

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

declare const reference: unique symbol
declare const version: unique symbol

// Reference identifies a snapshot within its storage scope; persistence requires a retained owner or published head.
export type Reference<State extends Json = Json> = string & { readonly [reference]: State }

// Version contains immutable JSON and its applied log position; null denotes initial state before replay.
export interface Version<State extends Json> {
  readonly [version]: true
  readonly value: State
  readonly sequence: number | null
  // reference exposes this version as a snapshot boundary during coalescing (test/reducer/properties.test.ts).
  readonly reference: Reference<State>
}

export interface Record<Event, Metadata> {
  readonly sequence: number
  readonly event: Event
  readonly metadata: Metadata
}

export interface Definition<State extends Json, Event, Metadata> {
  readonly name: string
  readonly schema: Schema.Decoder<State>
  readonly input: Schema.Decoder<Event>
  readonly initial: State
  readonly reduce: (state: State, event: Event, metadata: Metadata, sequence: number) => State
}

// Materialization applies ordered records; applying a record stages a version without publishing it.
export interface Materialization<State extends Json, Event, Metadata> {
  readonly initial: () => Version<State>
  readonly apply: (previous: Version<State>, record: Record<Event, Metadata>) => Version<State>
  readonly head: () => Version<State> | null
  readonly open: (reference: Reference<State>) => Version<State>
  readonly publish: (tx: Transaction, next: Version<State>, options: { readonly expected: Reference<State> | null }) => void
}
