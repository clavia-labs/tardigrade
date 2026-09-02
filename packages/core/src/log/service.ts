import { Context, Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"

export interface ThreadEventRow {
  readonly seq: number
  readonly event: Event
}

export interface AppendResult {
  readonly appended: number
  readonly head: number
}

// ThreadEventStore is the durable boundary for one thread's event log. A host and its reactors
// share this object, so every read and append observes the same application policy.
export interface ThreadEventStore {
  readonly append: (events: ReadonlyArray<Event>) => Effect.Effect<AppendResult>
  readonly read: Effect.Effect<ReadonlyArray<Event>>
  readonly head: Effect.Effect<number>
  readonly readFrom: (mark: number) => Effect.Effect<ReadonlyArray<Event>>
  readonly readPage: (mark: number, limit: number) => Effect.Effect<ReadonlyArray<ThreadEventRow>>
}

// EventLog is the one durable thing; append is the only mutation in the system (tla/runtime/Log.tla).
// State is a projection of it: replay is re-derivation, recovery is re-settling.
//
// A store that binds this port owes six guarantees.
//
// 1. Append only. A committed event binds forever; compaction appends, never deletes.
// 2. Total order per log. The watermark rises and never repeats.
// 3. One writer per log. The platform serializes appends per actor.
// 4. Atomic append of a batch. A crash leaves all of it or none of it.
// 5. Dedup by key. A keyed redelivery is absorbed; an absorbed append leaves `head` unchanged.
// 6. Ordered tail from a watermark. `readFrom(mark)` returns exactly the events after `mark`.
// 7. Bounded ordered page. `readPage(mark, limit)` returns at most `limit` rows after `mark` with their durable sequence numbers.
//
// `head` is the store's own testimony of progress: the settle loop compares it instead of
// materializing the log (packages/core/src/runtime/reconciler.ts, settleActor).
export class EventLog extends Context.Service<
  EventLog,
  {
    readonly append: (events: ReadonlyArray<Event>) => Effect.Effect<void>
    readonly read: Effect.Effect<ReadonlyArray<Event>>
    readonly head: Effect.Effect<number>
    readonly readFrom: (mark: number) => Effect.Effect<ReadonlyArray<Event>>
  }
>()("tardigrade/EventLog") {}

// eventLogFrom adapts a thread store to the reactor port while preserving the store as the host's
// persistence boundary.
export const eventLogFrom = (store: ThreadEventStore): Context.Service.Shape<typeof EventLog> => ({
  append: (events) => store.append(events).pipe(Effect.asVoid),
  read: store.read,
  head: store.head,
  readFrom: (mark) => store.readFrom(mark)
})

// withWatermark derives `head` and `readFrom` for a store that only has `append` and `read`:
// the watermark is the event count. Correct for any append-only array binding; a real store
// answers from its own sequence column instead.
export const withWatermark = (store: {
  readonly append: (events: ReadonlyArray<Event>) => Effect.Effect<void>
  readonly read: Effect.Effect<ReadonlyArray<Event>>
}): Context.Service.Shape<typeof EventLog> => ({
  ...store,
  head: Effect.map(store.read, (events) => events.length),
  readFrom: (mark) => Effect.map(store.read, (events) => events.slice(mark))
})
