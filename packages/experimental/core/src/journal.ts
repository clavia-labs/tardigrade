import type { Effect } from "effect"
import type { CoreEvent } from "./lifecycle"

export type Recorded<Event> = Event | CoreEvent

// Journal stores an ordered event prefix; append commits a batch atomically or rejects a stale expected length.
export interface Journal<Event extends object> {
  readonly read: Effect.Effect<readonly Recorded<Event>[], Error>
  readonly append: (expectedLength: number, events: readonly Recorded<Event>[]) => Effect.Effect<void, Error>
}
