import { Schema, type Effect } from "effect"
import { MessageMetadata, type MessageReceived } from "../actor/message"
import type { CoreEvent, ObservedCoreEvent } from "../runtime/events"

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

// Journal stores an ordered event prefix; append commits a batch atomically or rejects a stale expected length.
export interface Journal<Event extends object> {
  readonly read: Effect.Effect<readonly Recorded<Event>[], Error>
  // readAfter returns the suffix starting at the consumed event count; positions beyond the journal length fail.
  readonly readAfter: (position: number) => Effect.Effect<readonly Recorded<Event>[], Error>
  readonly append: (expectedLength: number, events: readonly Recorded<Event>[]) => Effect.Effect<void, Error>
  readonly readCheckpoint: Effect.Effect<StoredCheckpoint | undefined, Error>
  readonly appendWithCheckpoint: (expectedLength: number, events: readonly Recorded<Event>[], checkpoint: StoredCheckpoint) => Effect.Effect<void, Error>
}

export interface MessageJournal<Event extends object> extends Journal<Event> {
  readonly readMessage: (id: string) => Effect.Effect<{ readonly position: number; readonly record: Recorded<Event> } | undefined, Error>
  readonly acknowledge: Effect.Effect<void, Error>
}

export class JournalConflict extends Error { readonly _tag = "JournalConflict" }
