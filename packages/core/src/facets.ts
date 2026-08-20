import { Context, Effect } from "effect"
import type { Event } from "./event"

// Facets is the observe privilege: it reads a sibling actor's committed log by name, the way
// Router reaches one and Self names this one. A facet is another lane's log seen from outside.
// A lane owns its own log through EventLog; the two privileges stay separate, so a reader
// cannot append.
//
// It exists only where logs share a store, a placement-2 privilege: a host whose lanes are
// remote provides a Facets that proxies the read or refuses it, and the caller sees the same
// shape either way. Beside Router (deliver) and Self (identity) it completes the cross-lane
// vocabulary, so a package that watches a sibling names a service instead of closing over a
// host (facets.test.ts, "Facets reads a sibling lane by name").
export class Facets extends Context.Service<
  Facets,
  {
    readonly read: (name: string) => Effect.Effect<ReadonlyArray<Event>>
  }
>()("tardigrade/Facets") {}
