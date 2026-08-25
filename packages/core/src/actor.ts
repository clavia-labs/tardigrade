import { Clock, Context, Effect } from "effect"
import { EventLog } from "./event-log"
import type { Event } from "./event"
import { triggerOf } from "./trace"
import type { ActorId } from "./communication/endpoint"

// Actor runtime gives one log a single writer and derives all state from that log
// (tla/runtime/Projection.tla). The platform serializes sends per actor.

// Self is the current actor's own address, bound by the platform per
// lane.
export class Self extends Context.Service<Self, ActorId>()("tardigrade/Self") {}

// Intent proposes events without external work. The actor supplies commit time, appends the result,
// and re-derives before more work (actor.properties.test.ts, "a committed intent invalidates every
// remaining transition from its snapshot"; tla/runtime/Coherence.tla, NoSuppressedCommit).
export interface Intent<T = unknown> {
  readonly kind: "intent"
  readonly key: string
  readonly input: T
  readonly events: (input: T, at: number) => ReadonlyArray<Event>
}

// ExternalEffect is one keyed unit of outside-world work. Its key and input are projections of the
// event set (tla/runtime/Reconcile.tla, CommitOne). Its action may append evidence, and one appended
// or returned event must derive the key.
export interface ExternalEffect<T = unknown, R = never> {
  readonly kind: "effect"
  readonly key: string
  readonly input: T
  readonly act: (input: T) => Effect.Effect<ReadonlyArray<Event>, never, EventLog | R>
}

// Transition is an intent or external effect offered from one log snapshot.
export type Transition<T = unknown, R = never> = Intent<T> | ExternalEffect<T, R>

// Reactor derives transitions as a pure projection of the event set. It ignores event order and
// ambient time (tla/runtime/Projection.tla, ViewFaithful), and it omits work whose prerequisite is
// absent (tla/runtime/Reconcile.tla, QuietIsBlocked).
export type Reactor<R = never> = (events: ReadonlyArray<Event>) => ReadonlyArray<Transition<never, R>>

// intent constructs an event proposal and erases its input type for heterogeneous reactors.
export const intent = <T>(proposal: {
  readonly key: string
  readonly input: T
  readonly events: (input: T, at: number) => ReadonlyArray<Event>
}): Intent<never> => ({ kind: "intent", ...proposal }) as unknown as Intent<never>

// effect constructs external work and erases its input type. The runtime calls act with the
// input from the same derivation.
export const effect = <T, R = never>(work: {
  readonly key: string
  readonly input: T
  readonly act: (input: T) => Effect.Effect<ReadonlyArray<Event>, never, EventLog | R>
}): ExternalEffect<never, R> => ({ kind: "effect", ...work }) as unknown as ExternalEffect<never, R>

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
        // transition.fire joins this transition to the delivery that enabled it.
        const fired = yield* Effect.gen(function* () {
          const returned = t.kind === "intent"
            ? t.events(t.input, yield* Clock.currentTimeMillis)
            : yield* t.act(t.input)
          if (returned.length > 0) yield* log.append(returned)
          const committed = recordedKeys(yield* log.read, a.keyOf).has(t.key)
          const outcome = committed
            ? "committed"
            : (yield* log.head) > before
              ? // advanced means the action recorded evidence without committing its key.
                "advanced"
              : returned.length === 0
                ? // blocked means the action returned no event and moved no log entry.
                  "blocked"
                : "wedged"
          yield* Effect.annotateCurrentSpan("outcome", outcome)
          return outcome
        }).pipe(
          Effect.withSpan("transition.fire", {
            attributes: { key: t.key, kind: t.kind },
            // triggerOf links the newest carried trace context to this fire.
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
      // moved stays false only when every enabled transition blocked.
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
