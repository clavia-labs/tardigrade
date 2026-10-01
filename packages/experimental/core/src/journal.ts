import type { Effect } from "effect"
import type { CoreEvent } from "./lifecycle"

// RecordMetadata carries host admission wall time separately from domain payloads.
export interface RecordMetadata {
  readonly recordedAt?: number
}

export type Recorded<Event> = (Event | CoreEvent) & RecordMetadata

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
