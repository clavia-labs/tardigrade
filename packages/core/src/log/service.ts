import { Context, Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"

// ThreadEventRow pairs a durable event with its position in a thread log.
export interface ThreadEventRow {
  readonly seq: number
  readonly event: Event
}

// AppendResult reports how many events were appended and the resulting log head.
export interface AppendResult {
  readonly appended: number
  readonly head: number
}

// ConditionalAppendResult reports whether a keyed condition refused the batch (platform/bun/src/host.test.ts, "a concurrent admission and seal race resolves with admission refused").
export interface ConditionalAppendResult extends AppendResult {
  readonly blocked: boolean
}

/**
 * ThreadEventStore is the durable boundary for one thread's event log.
 *
 *   ThreadEventStore
 *     ├── append(events)       commit an atomic event batch
 *     ├── appendUnlessKeyPresent(events, key)  commit the batch unless the key is already stored
 *     ├── read                 read the complete log
 *     ├── head                 read the latest durable sequence
 *     ├── readFrom(mark)       read the event tail after a mark
 *     └── readPage(mark, size) read a bounded tail with sequence numbers
 */
export interface ThreadEventStore {
  readonly append: (events: ReadonlyArray<Event>) => Effect.Effect<AppendResult>
  readonly appendUnlessKeyPresent: (
    events: ReadonlyArray<Event>,
    key: string
  ) => Effect.Effect<ConditionalAppendResult>
  readonly read: Effect.Effect<ReadonlyArray<Event>>
  readonly head: Effect.Effect<number>
  readonly readFrom: (mark: number) => Effect.Effect<ReadonlyArray<Event>>
  readonly readPage: (mark: number, limit: number) => Effect.Effect<ReadonlyArray<ThreadEventRow>>
}

/**
 * EventLog is the runtime port for the immutable event history of one thread.
 *
 *   EventLog
 *     ├── append(events)   commit events
 *     ├── read             read complete history
 *     ├── head             read the current watermark
 *     └── readFrom(mark)   read events after a watermark
 *
 * Bindings preserve append-only storage, total order, serialized writes, atomic batches, keyed deduplication, and ordered tail reads (tla/runtime/Log.tla). An absorbed keyed append leaves the head unchanged.
 */
export class EventLog extends Context.Service<
  EventLog,
  {
    readonly append: (events: ReadonlyArray<Event>) => Effect.Effect<void>
    readonly read: Effect.Effect<ReadonlyArray<Event>>
    readonly head: Effect.Effect<number>
    readonly readFrom: (mark: number) => Effect.Effect<ReadonlyArray<Event>>
  }
>()("tardigrade/EventLog") {}

// eventLogFrom adapts a thread event store to the runtime event-log port.
export const eventLogFrom = (store: ThreadEventStore): Context.Service.Shape<typeof EventLog> => ({
  append: (events) => store.append(events).pipe(Effect.asVoid),
  read: store.read,
  head: store.head,
  readFrom: (mark) => store.readFrom(mark)
})

// withWatermark derives tail reads from event count for append-only stores without native sequence access.
export const withWatermark = (store: {
  readonly append: (events: ReadonlyArray<Event>) => Effect.Effect<void>
  readonly read: Effect.Effect<ReadonlyArray<Event>>
}): Context.Service.Shape<typeof EventLog> => ({
  ...store,
  head: Effect.map(store.read, (events) => events.length),
  readFrom: (mark) => Effect.map(store.read, (events) => events.slice(mark))
})
