import { Context, Effect } from "effect"
import type { Event } from "./event"

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
//
// `head` is the store's own testimony of progress: the settle loop compares it instead of
// materializing the log (packages/core/src/reconciliation/reconciler.ts, settleActor).
export class EventLog extends Context.Service<
  EventLog,
  {
    readonly append: (events: ReadonlyArray<Event>) => Effect.Effect<void>
    readonly read: Effect.Effect<ReadonlyArray<Event>>
    readonly head: Effect.Effect<number>
    readonly readFrom: (mark: number) => Effect.Effect<ReadonlyArray<Event>>
  }
>()("tardigrade/EventLog") {}

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
