import type { DocumentChanges, DocumentSession } from "./tree-state"
import { Schema, type Effect } from "effect"
import { MessageMetadata, type MessageReceived } from "../actor/message"
import type { CoreEvent, ObservedCoreEvent } from "../runtime/events"
import { EffectRef } from "../runtime/effects"
import { EffectRequest } from "../runtime/events"

// RecordMetadata carries journal time and host-established delivery context separately from event payloads.
export const RecordMetadata = Schema.Struct({
  message: Schema.optionalKey(MessageMetadata),
  recordedAt: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))),
})
export type RecordMetadata = typeof RecordMetadata.Type

export type RuntimeEvent<Event> = Event | CoreEvent

export type JournalEvent<Event> = RuntimeEvent<Event> | MessageReceived

export interface Recorded<Event> extends RecordMetadata {
  readonly event: JournalEvent<Event>
}

export interface ObservedRecord<Event> extends RecordMetadata {
  readonly event: Event | ObservedCoreEvent
}

export interface StoredCheckpoint {
  readonly position: number
  readonly payload: Uint8Array
  readonly digest: string
}

export const PendingEffectInput = Schema.Struct({ ref: EffectRef, request: EffectRequest })
export type PendingEffectInput = typeof PendingEffectInput.Type

// EffectInputChanges commits accepted payloads and terminal releases with journal records (quint/checkpoint/inputLifecycle.qnt, inputRetained).
export interface EffectInputChanges {
  readonly documents?: DocumentChanges
  readonly put?: readonly PendingEffectInput[]
  readonly remove?: readonly EffectRef[]
}

// Journal colocates events and Grove values; append commits records, referenced dependencies and retention atomically (platform/test/bun/stored-journal.test.ts).
export interface Journal<Event extends object> {
  readonly storedValues: DocumentSession
  readonly read: Effect.Effect<readonly Recorded<Event>[], Error>
  // readAfter returns the suffix starting at the consumed event count; positions beyond the journal length fail.
  readonly readAfter: (position: number) => Effect.Effect<readonly Recorded<Event>[], Error>
  readonly readInputs: Effect.Effect<readonly PendingEffectInput[], Error>
  readonly append: (expectedLength: number, events: readonly Recorded<Event>[], inputs?: EffectInputChanges) => Effect.Effect<void, Error>
  readonly readCheckpoint: Effect.Effect<StoredCheckpoint | undefined, Error>
  readonly appendWithCheckpoint: (expectedLength: number, events: readonly Recorded<Event>[], checkpoint: StoredCheckpoint, inputs?: EffectInputChanges) => Effect.Effect<void, Error>
}

export interface MessageJournal<Event extends object> extends Journal<Event> {
  readonly readMessage: (id: string) => Effect.Effect<{ readonly position: number; readonly record: Recorded<Event> } | undefined, Error>
  // acknowledge completes durability and recovery synchronization before confirming an existing receipt (platform/test/properties/journal-acknowledgement.ts).
  readonly acknowledge: Effect.Effect<void, Error>
}

export class JournalConflict extends Error { readonly _tag = "JournalConflict" }
