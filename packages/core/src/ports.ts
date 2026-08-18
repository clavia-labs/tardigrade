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

// A wake at a due time. The caller records why it is waiting in the log, then asks the runtime to
// deliver `event` to `session` at `at`. The machine rests. A restart reads the log and arms again.
//
// The port is the schedule, not the wait: `set` returns once the wake is armed. Durable Objects
// bind it to `state.storage.setAlarm`. A Postgres runtime writes a due-time index. In memory it is
// a timer. One arm per session; a later `set` replaces the earlier one.
export class Alarm extends Context.Service<
  Alarm,
  {
    readonly set: (session: string, at: number, event: Event) => Effect.Effect<void>
  }
>()("flamecast/Alarm") {}
