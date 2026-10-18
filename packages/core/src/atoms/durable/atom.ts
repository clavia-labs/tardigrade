import { Schema } from "effect"
import { collectionSchema, type CollectionSchema, type Json, type MerkleTree } from "@tardie/grove"
import { documentAtom, type CheckpointReader, type DocumentOptions } from "./merkle"
import { valueAtom } from "./value"
import type { Atom } from "../atom"
import type { StatefulAtom } from "../../initialise"
import type { RecordMetadata } from "../../services/journal"

export interface DurableAtom<State, Event> extends Atom<State>, StatefulAtom {
  readonly input: Schema.Schema<Event>
}
export type DurableState<S extends Schema.Top> = CollectionSchema<S> extends true ? S["Type"] extends Json ? MerkleTree<S["Type"]> : never : S["Type"]
type Hooks<S extends Schema.Top> = CollectionSchema<S> extends true ? {
  readonly initialize?: (read: CheckpointReader) => S["Type"]
  readonly restore?: (state: NoInfer<DurableState<S>>, read: CheckpointReader) => NoInfer<DurableState<S>>
  readonly migrate?: (stored: unknown) => unknown
} : {}

// durableAtom selects Grove documents from collection declarations and warns at construction for legacy plain reducers (properties/collections.test.ts).
export function durableAtom<S extends Schema.Schema<unknown>, Event>(options: {
  readonly name: string
  readonly schema: S
  readonly input: Schema.Schema<Event>
  readonly initial: NoInfer<S["Type"]>
  readonly reduce: (state: NoInfer<DurableState<S>>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<DurableState<S>>
} & Hooks<S>): DurableAtom<DurableState<S>, Event>
/** @deprecated durableAtom with plain state should declare tree, appendOnly or keyValue. */
export function durableAtom<State, Event>(options: {
  readonly name: string
  readonly schema: Schema.Schema<State>
  readonly input: Schema.Schema<Event>
  readonly initial: NoInfer<State>
  readonly reduce: (state: NoInfer<State>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<State>
}): DurableAtom<State, Event>
export function durableAtom<S extends Schema.Schema<unknown>, Event>(options: {
  readonly name: string
  readonly schema: S
  readonly input: Schema.Schema<Event>
  readonly initial: NoInfer<S["Type"]>
  readonly reduce: (state: NoInfer<DurableState<S>>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<DurableState<S>>
} & Hooks<S>): DurableAtom<DurableState<S>, Event> {
  if (collectionSchema(options.schema.ast)) {
    return documentAtom(options as unknown as DocumentOptions<S["Type"] & Json, Event>) as unknown as DurableAtom<DurableState<S>, Event>
  }
  return valueAtom(options as unknown as Parameters<typeof valueAtom<S["Type"], Event>>[0]) as unknown as DurableAtom<DurableState<S>, Event>
}
