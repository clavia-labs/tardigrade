import { Context, Effect } from "effect"
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
