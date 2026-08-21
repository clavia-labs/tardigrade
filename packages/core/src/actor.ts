import { Context, Effect } from "effect"
import { EventLog } from "./event-log"
import type { Event } from "./event"
import { triggerOf } from "./trace"
import type { ActorAddress } from "./communication/address"

// An actor is the single writer of one log and the reactors over it.
// All state is a projection of the log: a crash loses nothing, and two
// readers cannot disagree (tla/Projection.tla). The log is mailbox and
// state at once; the platform must serialize sends per actor
// (src/platform/host.ts).

// Self is the current actor's own address, bound by the platform per
// lane.
export class Self extends Context.Service<Self, ActorAddress>()("tardigrade/Self") {}

// Transition is one keyed unit of work: state in, events out. The
// runtime fires a transition only when no record derives its key; a
// retried fire absorbs. `key` and `input` must be projections of the
// event set (tla/Reconcile.tla, CommitOne), so a re-derived transition
// cannot ask a different question under the same key. `act` may be
// nondeterministic and may append evidence itself; one returned or
// appended event must derive the key, or the work did not commit.
export interface Transition<T = unknown, R = never> {
  readonly key: string
  readonly input: T
  readonly act: (input: T) => Effect.Effect<ReadonlyArray<Event>, never, EventLog | R>
}

// Reactor derives the transitions the log enables: a pure projection
// into work. It must ignore event order (tla/Projection.tla,
// ViewFaithful) and never read the clock or the random source; time is
// data on the events. It never checks its own past: the key is the
// only memory. It derives only enabled work; a transition whose
// prerequisite is absent from the event set stays underived, so
// quiescence stays honest (tla/Reconcile.tla, QuietIsBlocked).
export type Reactor<R = never> = (events: ReadonlyArray<Event>) => ReadonlyArray<Transition<never, R>>

// transition pins T at the construction site, then forgets it: an
// actor's reactors return heterogeneous transitions, and the runtime
// only ever calls `act(input)` with the input the same derivation
// produced, so the erasure is sound by construction.
export const transition = <T, R = never>(t: {
  readonly key: string
  readonly input: T
  readonly act: (input: T) => Effect.Effect<ReadonlyArray<Event>, never, EventLog | R>
}): Transition<never, R> => t as unknown as Transition<never, R>

// Actor carries the reactors and the key derivation that decides
// commitment: the composed fragment table (composeKeys), the same
// derivation the store dedups with, so "did this transition fire" and
// "absorb this redelivery" can never disagree.
export interface Actor<R = never> {
  readonly reactors: ReadonlyArray<Reactor<R>>
  readonly keyOf: (e: Event) => string | undefined
}

export const actor = <R = never>(
  reactors: ReadonlyArray<Reactor<R>>,
  keyOf: (e: Event) => string | undefined
): Actor<R> => ({ reactors, keyOf })

const recordedKeys = (events: ReadonlyArray<Event>, keyOf: Actor["keyOf"]): Set<string> => {
  const keys = new Set<string>()
  for (const e of events) {
    const key = keyOf(e)
    if (key !== undefined) keys.add(key)
  }
  return keys
}

// enabled returns the transitions the log enables and does not record:
// the diff between derived and done, and the only definition of owed
// work.
export const enabled = <R>(a: Actor<R>, events: ReadonlyArray<Event>): ReadonlyArray<Transition<never, R>> => {
  const recorded = recordedKeys(events, a.keyOf)
  return a.reactors.flatMap((derive) => derive(events)).filter((t) => !recorded.has(t.key))
}

// restingActor reports quiescence to the platform alarm: no reactor
// enables a transition. The alarm may be deleted only on a true answer
// (tla/Driver.tla, Accounting); recomputing from the log keeps it
// true.
export const restingActor = <R>(a: Actor<R>, events: ReadonlyArray<Event>): boolean =>
  enabled(a, events).length === 0

// settleActor fires every enabled transition, re-derives, and repeats
// until a full pass enables nothing new. Each fire has three honest
// outcomes: committed (an event derives the key), blocked (the act
// recorded no key; derivation stops until the world moves), or wedged
// (the act returned events, none derives its key, none landed), which
// dies naming the transition, because a silent spin is the one outcome
// worse than a crash. Progress is the store's watermark. Liveness is
// the caller's debt, paid by the platform alarm (tla/Driver.tla,
// EventuallyServed).
export const settleActor = <R>(a: Actor<R>): Effect.Effect<void, never, EventLog | R> =>
  Effect.gen(function* () {
    const log = yield* EventLog
    while (true) {
      const events = yield* log.read
      const fires = enabled(a, events)
      if (fires.length === 0) return
      const trigger = triggerOf(events)
      let moved = false
      for (const t of fires) {
        const before = yield* log.head
        // The fire is the reconciler's unit of work, so it is the span: the transition key
        // joins the trace to the log, and the outcome is the one question every trace query
        // starts with. Inert without a tracer.
        const fired = yield* Effect.gen(function* () {
          const returned = yield* t.act(t.input)
          if (returned.length > 0) yield* log.append(returned)
          const committed = recordedKeys(yield* log.read, a.keyOf).has(t.key)
          const outcome = committed
            ? "committed"
            : (yield* log.head) > before
              ? // Progress without the key: the act recorded evidence (its sends, a BlockedOn)
                // and stopped. Re-derive: a transient attempt that recorded its send retries in
                // this settle, and a genuine park's evidence suppresses its own re-derivation
                // until the world moves.
                "advanced"
              : returned.length === 0
                ? // Blocked with nothing to say: a park already on record, or a transient
                  // failure with none. Legal; the platform alarm re-drives when the world moves.
                  "blocked"
                : "wedged"
          yield* Effect.annotateCurrentSpan("outcome", outcome)
          return outcome
        }).pipe(
          Effect.withSpan("transition.fire", {
            attributes: { key: t.key },
            // The link to the delivery that woke this work: the cross-lane seam of the trace
            // (packages/core/src/trace.ts, triggerOf).
            ...(trigger === undefined ? {} : { links: [{ span: trigger, attributes: {} }] })
          })
        )
        if (fired === "committed" || fired === "advanced") {
          moved = true
        } else if (fired === "wedged") {
          return yield* Effect.die(
            new Error(`transition "${t.key}" wedged: its events carry no committing key and none landed`)
          )
        }
      }
      // A pass that moved nothing was blocks all the way down: stop;
      // deliveries and the alarm re-enter. Any movement re-derives,
      // because recorded work enables new transitions.
      if (!moved) return
    }
  })

// send appends one event and settles the actor.
export const send = <R>(a: Actor<R>, event: Event): Effect.Effect<void, never, EventLog | R> =>
  Effect.gen(function* () {
    const log = yield* EventLog
    yield* log.append([event])
    yield* settleActor(a)
  })
