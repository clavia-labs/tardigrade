import { Context, Effect } from "effect"
import { EventLog } from "./event-log"
import { settleAll, type Machine } from "./machine"
import type { Event } from "./event"

// The actor: the single writer of one log, running a set of machines over it. Identity comes from
// the log. Behavior comes from the machines. The log is the mailbox and the state at once, so a
// send is append-then-settle and there is no queue to build: the runtime serializes sends through
// the Writer port, and one session processes one send at a time.

// The session's own address: who "I" am when a machine sends outward. A runtime binds it to the
// session's durable identity; a test binds a name.
export class Self extends Context.Service<Self, string>()("flamecast/Self") {}

export interface Actor<R = never> {
  readonly machines: ReadonlyArray<Machine<R, never>>
}

export const actor = <R = never>(machines: ReadonlyArray<Machine<R, never>>): Actor<R> => ({
  machines
})

// Send one event to the actor: append it to the log, then settle the machines to quiescence.
//
// A settle with no new event is the recovery entry point, and it is `settleAll` over the same
// machines. A crash leaves committed events; re-settling folds them and continues where the dead
// settle stopped.
export const send = <R>(
  a: Actor<R>,
  event: Event
): Effect.Effect<void, never, EventLog | R> =>
  Effect.gen(function* () {
    const store = yield* EventLog
    yield* store.append([event])
    yield* settleAll(a.machines)
  })
