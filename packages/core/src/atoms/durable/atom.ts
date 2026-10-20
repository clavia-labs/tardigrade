import { Schema } from "effect"
import { isValue, collectionSchema, type ValueSchema, type CollectionSchema, type Json, type MerkleTree } from "@tardie/grove"
import { documentAtom, type CheckpointReader, type DocumentOptions } from "./merkle"
import { plainAtom } from "./plain"
import { wholeValueAtom } from "./whole-value"
import type { Atom } from "../atom"
import type { StatefulAtom } from "../../initialise"
import type { RecordMetadata } from "../../services/journal"

export interface DurableAtom<State, Event, S extends Schema.Top = Schema.Top> extends Atom<State>, StatefulAtom {
  readonly name: string
  readonly schema: S
  readonly input: Schema.Schema<Event>
}
export type DurableState<S extends Schema.Top> = CollectionSchema<S> extends true ? S["Type"] extends Json ? MerkleTree<S["Type"]> : never : S["Type"]
type Hooks<S extends Schema.Top> = CollectionSchema<S> extends true ? {
  readonly initialize?: (read: CheckpointReader) => S["Type"]
  readonly restore?: (state: NoInfer<DurableState<S>>, read: CheckpointReader) => NoInfer<DurableState<S>>
  readonly migrate?: (stored: unknown) => unknown
} : ValueSchema<S> extends true ? { readonly migrate?: (stored: unknown) => unknown } : {
  readonly initialize?: (read: CheckpointReader) => S["Type"]
  readonly restore?: (state: S["Type"], read: CheckpointReader) => S["Type"]
  readonly migrate?: (stored: unknown) => unknown
}

// durableAtom binds plain JSON reducers or explicit collection declarations to durable materialisation (properties/collections.test.ts).
export function durableAtom<S extends Schema.Schema<unknown>, Event>(options: {
  readonly name: string
  readonly schema: S
  readonly input: Schema.Schema<Event>
  readonly initial: NoInfer<S["Type"]>
  readonly reduce: (state: NoInfer<DurableState<S>>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<DurableState<S>>
} & Hooks<S>): DurableAtom<DurableState<S>, Event, S>
export function durableAtom<State, Event>(options: {
  readonly name: string
  readonly schema: Schema.Schema<State>
  readonly input: Schema.Schema<Event>
  readonly initial: NoInfer<State>
  readonly reduce: (state: NoInfer<State>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<State>
}): DurableAtom<State, Event, Schema.Schema<State>>
export function durableAtom<S extends Schema.Schema<unknown>, Event>(options: {
  readonly name: string
  readonly schema: S
  readonly input: Schema.Schema<Event>
  readonly initial: NoInfer<S["Type"]>
  readonly reduce: (state: NoInfer<DurableState<S>>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<DurableState<S>>
} & Hooks<S>): DurableAtom<DurableState<S>, Event, S> {
  if (isValue(options.schema.ast)) return wholeValueAtom(options as unknown as Parameters<typeof wholeValueAtom<S["Type"] & Json, Event>>[0]) as unknown as DurableAtom<DurableState<S>, Event, S>
  if (collectionSchema(options.schema.ast)) {
    return documentAtom(options as unknown as DocumentOptions<S["Type"] & Json, Event>) as unknown as DurableAtom<DurableState<S>, Event, S>
  }
  return plainAtom(options as unknown as Parameters<typeof plainAtom<S["Type"] & Json, Event>>[0]) as unknown as DurableAtom<DurableState<S>, Event, S>
}
