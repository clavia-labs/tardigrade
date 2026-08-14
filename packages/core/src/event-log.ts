import { Context, Effect } from "effect"
import type { Envelope } from "./envelope"

// The event log: the one durable thing in the system. State is a fold over it, and nothing holds
// session state outside it. The core states the port; a runtime binds it to real storage.
//
// A store that binds this port owes six guarantees.
//
// 1. Append only. A committed event binds forever. Compaction appends a checkpoint and deletes
//    nothing.
// 2. Total order per session. `seq` rises and never repeats.
// 3. One writer per session. A second writer waits or fails, so two turns never interleave their
//    events. `settle` reads the log once and then tracks the tail it appends, which is exact
//    under this guarantee alone.
// 4. Atomic append of a batch. A decide or an act returns an array, and the array commits as one
//    unit, so a crash leaves all of it or none of it.
// 5. Dedup by key. Each event derives a key, and a unique index absorbs a redelivered event. An
//    event with no key always lands, which is why a repeated mark stays in the log as evidence.
// 6. Read in order from a watermark. `readFrom(seq)` returns the tail after `seq`.
//
// Guarantee 6 is why `readFrom` and `head` sit beside `read`. A settle reads the log on every loop
// pass. A local SQLite file makes a full `read` cheap, and a network store makes it quadratic in
// the length of a turn. The incremental door keeps a remote log affordable.
export interface EventLogStore {
  readonly append: (events: ReadonlyArray<Envelope>) => Effect.Effect<void>
  readonly read: Effect.Effect<ReadonlyArray<Envelope>>
  readonly readFrom: (seq: number) => Effect.Effect<ReadonlyArray<Envelope>>
  readonly head: Effect.Effect<number>
}

export class EventLog extends Context.Service<EventLog, EventLogStore>()("flamecast/EventLog") {}

// The dedup key of an event, where one exists. The key is what guarantee 5 absorbs on, and an
// event with no key always lands.
//
// The derivation is a policy of the harness that owns the event alphabet, so it arrives as a
// function rather than a table in the core. A core that held the table would have to know
// `ToolReturned` and `RunFired`, and the core knows no domain.
export type DedupKey = (event: Envelope) => string | undefined

// The key policy the core ships: an event states its own identity in a `key` field. It is the
// door an outside sender uses when it can redeliver, and it is enough for a runtime to satisfy
// guarantee 5 with no domain knowledge at all. A harness that derives keys from its own alphabet
// passes its own function to the runtime and to the conformance kit.
export const dedupKey: DedupKey = (event) => (typeof event.key === "string" ? event.key : undefined)
