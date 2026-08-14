import { Context, Effect } from "effect"
import type { Envelope } from "./envelope"

// The router: how one session reaches another. An address names a session; the runtime resolves it
// to that session's log and machines. Delivery is at-least-once, and every receiver dedups on its
// own keys, so a redelivered event is absorbed.
//
// `deliver` is the async door: append the event to the target and settle it, eventually. `call` is
// the sync door: run the target to quiescence and return the event that ended it. Sync is for
// quick, acyclic sub-calls; a call cycle deadlocks on the single writer per session, and long work
// goes through `deliver` with the answer coming home as an inbound event.
//
// Both doors carry Envelopes in and an Envelope out, so the core stays free of domain vocabulary. A
// turn that ends carries its outcome in the event that ended it, and the harness narrows on `type`
// to read it. Resuming a session that parked is `deliver` of the event the park waits on.
export class Router extends Context.Service<
  Router,
  {
    readonly deliver: (address: string, event: Envelope) => Effect.Effect<void>
    readonly call: (address: string, event: Envelope) => Effect.Effect<Envelope>
  }
>()("flamecast/Router") {}
