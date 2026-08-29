import { Clock, Context, Effect } from "effect"
import type { ThreadAddress } from "../communication/endpoint"
import type { Event } from "../log/event"
import { EventLog } from "../log"
import { triggerOf } from "../log/trace"
import type { Reactor } from "./reactor"
import type { Transition } from "./transition"

// Actor runtime gives one log a single writer and derives all state from that log
// (tla/runtime/Projection.tla). The platform serializes sends per actor.

// Self is the current actor's own address, bound by the platform per thread.
export class Self extends Context.Service<Self, ThreadAddress>()("tardigrade/Self") {}

// Actor carries reactors and the key projection used for commitment and redelivery deduplication.
export interface Actor<R = never> {
  readonly reactors: ReadonlyArray<Reactor<R>>
  readonly keyOf: (e: Event) => string | undefined
}

// actorFromReactors constructs the reconciler surface from low-level transition projections.
export const actorFromReactors = <R = never>(
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

// enabled returns derived transitions whose keys the log does not record.
export const enabled = <R>(a: Actor<R>, events: ReadonlyArray<Event>): ReadonlyArray<Transition<never, R>> => {
  const recorded = recordedKeys(events, a.keyOf)
  return a.reactors.flatMap((derive) => derive(events)).filter((t) => !recorded.has(t.key))
}

// restingActor reports whether the log enables no transition
// (tla/runtime/Driver.tla, Accounting).
export const restingActor = <R>(a: Actor<R>, events: ReadonlyArray<Event>): boolean =>
  enabled(a, events).length === 0

// settleActor attempts enabled transitions until the actor rests. Any log movement starts a fresh
// derivation before another transition fires (actor.properties.test.ts, "a committed intent
// invalidates every remaining transition from its snapshot"; tla/runtime/Coherence.tla,
// NoSuppressedCommit). A fire may commit, advance, block, or wedge; a wedge dies, and the platform
// alarm re-drives blocked work (tla/runtime/Driver.tla, EventuallyServed).
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
        const fired = yield* Effect.gen(function* () {
          const returned = t.kind === "intent"
            ? t.events(t.input, yield* Clock.currentTimeMillis)
            : yield* t.act(t.input)
          if (returned.length > 0) yield* log.append(returned)
          const committed = recordedKeys(yield* log.read, a.keyOf).has(t.key)
          const outcome = committed
            ? "committed"
            : (yield* log.head) > before
              ? "advanced"
              : returned.length === 0
                ? "blocked"
                : "wedged"
          yield* Effect.annotateCurrentSpan("outcome", outcome)
          return outcome
        }).pipe(
          Effect.withSpan("transition.fire", {
            attributes: { key: t.key, kind: t.kind },
            ...(trigger === undefined ? {} : { links: [{ span: trigger, attributes: {} }] })
          })
        )
        if (fired === "committed" || fired === "advanced") {
          moved = true
          break
        } else if (fired === "wedged") {
          return yield* Effect.die(
            new Error(`${t.kind} "${t.key}" wedged: its events carry no committing key and none landed`)
          )
        }
      }
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
