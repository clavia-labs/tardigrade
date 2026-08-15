import { Context, Effect } from "effect"
import type { Event } from "./event"

// The read side of a runtime that serves more than one session. `Router` sends to an address, and
// this reads what the address did: the log of one session, and the addresses the runtime is
// currently serving.
//
// It is a port rather than a value a caller holds, because only the runtime knows where a session
// lives. A single-process runtime reads its own map, and a durable one lists a namespace and reads
// a session's rows.
//
// Reading a session is reading a log, so every projection in the harness applies unchanged to
// another session's evidence. That is the whole inspection surface for a swarm: the tree of
// deliveries is derived from the `origin` each inbound head carries, so nothing here needs to know
// about delegation.
export class Sessions extends Context.Service<
  Sessions,
  {
    readonly list: Effect.Effect<ReadonlyArray<string>>
    readonly read: (address: string) => Effect.Effect<ReadonlyArray<Event>>
  }
>()("flamecast/Sessions") {}
