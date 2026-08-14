import { Context, Effect } from "effect"
import type { Event } from "./event"

// The platform seams that are not the log. Each one is a guarantee every runtime owes and no
// runtime owes twice: the core names what it needs, and one layer binds the set. A port here holds
// no domain knowledge, so the same agent code runs on a laptop, on a server, and on an edge worker.

// The single-writer lease. Exactly one execution context appends to one session at a time, so two
// concurrent turns can not interleave their events and a race on session state can not occur.
//
// Every platform supplies the guarantee with the tool it already has: a mutex in one process, a
// Postgres advisory lock across processes, a Durable Object by construction, an S3
// compare-and-swap lease on a cell.
export class Writer extends Context.Service<
  Writer,
  {
    readonly hold: <A, E, R>(session: string, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  }
>()("flamecast/Writer") {}

// The timer. A watchdog needs it, and so does the liveness bound on an inference. `armIfSooner`
// sets the alarm when the new time is earlier than the one already armed, so the nearest deadline
// wins and an arm is idempotent. `owed` is the table a restart re-arms from.
export class Wake extends Context.Service<
  Wake,
  {
    readonly armIfSooner: (at: number) => Effect.Effect<void>
    readonly owed: Effect.Effect<ReadonlyArray<{ session: string; at: number }>>
  }
>()("flamecast/Wake") {}

// The map from a session address to its host. A single-process runtime returns the one host. A
// distributed runtime hashes the address to a node, or asks a directory.
export class Placement extends Context.Service<
  Placement,
  { readonly home: (address: string) => Effect.Effect<string> }
>()("flamecast/Placement") {}

// Storage for a value too large to sit inside one event. The event holds the reference and the
// value sits in a blob store, so the log rows stay small and a fold stays fast even when a tool
// returns a large payload.
export class Spill extends Context.Service<
  Spill,
  {
    readonly put: (value: Uint8Array) => Effect.Effect<string>
    readonly get: (ref: string) => Effect.Effect<Uint8Array>
  }
>()("flamecast/Spill") {}

// One outbound record is one event, plus the session and the turn it belongs to.
export type SinkRecord = Event & { readonly session: string; readonly turn?: string }

// Outbound events and spans. Telemetry is optional and the binding decides where it goes. The
// stored log is complete whichever sink you bind, so a silent sink loses no evidence.
export class Sink extends Context.Service<
  Sink,
  { readonly write: (records: ReadonlyArray<SinkRecord>) => Effect.Effect<void> }
>()("flamecast/Sink") {}
