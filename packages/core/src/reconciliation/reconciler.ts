import { Cause, Clock, Context, Effect, Option } from "effect"
import type { ThreadAddress } from "../communication/endpoint"
import type { Event } from "../log/event"
import { EventLog } from "../log"
import { triggerOf } from "../log/trace"
import type { Reactor } from "./reactor"
import type { ExternalEffect, Transition } from "./transition"
import type { ActorInvocation } from "../actor/method"
import type { ActorMethodCancellationState } from "../actor/method"
import { cancelsInvocation } from "../actor/method/cancellation"

// Actor runtime gives one log a single writer and derives all state from that log
// (tla/runtime/Projection.tla). The platform serializes sends per actor.

// Self is the current actor's own address, bound by the platform per thread.
export class Self extends Context.Service<Self, ThreadAddress>()("tardigrade/Self") {}

export interface EffectInterruptionRegistry {
  readonly register: (interrupts: (event: Event) => boolean, controller: AbortController) => () => void
  readonly interrupt: (events: ReadonlyArray<Event>) => void
}

// EffectInterruptions exposes live effects to the host that appends their invalidating events.
export class EffectInterruptions extends Context.Service<EffectInterruptions, EffectInterruptionRegistry>()(
  "tardigrade/EffectInterruptions"
) {}

// effectInterruptionRegistry creates the per-thread registry shared by its log and reconciler.
export const effectInterruptionRegistry = (): EffectInterruptionRegistry => {
  const running = new Map<AbortController, (event: Event) => boolean>()
  return {
    register: (interrupts, controller) => {
      running.set(controller, interrupts)
      return () => running.delete(controller)
    },
    interrupt: (events) => {
      for (const [controller, interrupts] of running) {
        if (events.some(interrupts)) controller.abort()
      }
    }
  }
}

// Actor carries reactors and the key projection used for commitment and redelivery deduplication.
export interface Actor<R = never> {
  readonly reactors: ReadonlyArray<Reactor<R>>
  readonly keyOf: (e: Event) => string | undefined
  readonly cancellationOf?: (
    events: ReadonlyArray<Event>,
    invocation: ActorInvocation
  ) => ActorMethodCancellationState | undefined
  readonly cancellationResiduals?: (
    events: ReadonlyArray<Event>
  ) => ReadonlyArray<Transition<never, R>> | undefined
}

// actorFromReactors constructs the reconciler surface from low-level transition projections.
export const actorFromReactors = <R = never>(
  reactors: ReadonlyArray<Reactor<R>>,
  keyOf: (e: Event) => string | undefined,
  cancellationOf?: Actor<R>["cancellationOf"],
  cancellationResiduals?: Actor<R>["cancellationResiduals"]
): Actor<R> => ({
  reactors,
  keyOf,
  ...(cancellationOf === undefined ? {} : { cancellationOf }),
  ...(cancellationResiduals === undefined ? {} : { cancellationResiduals })
})

const recordedKeys = (events: ReadonlyArray<Event>, keyOf: Actor["keyOf"]): Set<string> => {
  const keys = new Set<string>()
  for (const e of events) {
    const key = keyOf(e)
    if (key !== undefined) keys.add(key)
  }
  return keys
}

const interruptedBy = (signal: AbortSignal): Effect.Effect<never> =>
  Effect.callback<never>((resume) => {
    const interrupt = () => resume(Effect.interrupt)
    if (signal.aborted) interrupt()
    else signal.addEventListener("abort", interrupt, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", interrupt))
  })

const abortController = (): AbortController => new AbortController()

const interruptionOf = <R>(
  transition: ExternalEffect<never, R>,
  cancellable: boolean
): ((event: Event) => boolean) | undefined => {
  if (transition.invocation === undefined || !cancellable) {
    return transition.interrupts === undefined ? undefined : (event) => transition.interrupts!(transition.input, event)
  }
  return (event) =>
    cancelsInvocation(event, transition.invocation!) || transition.interrupts?.(transition.input, event) === true
}

const runExternalEffect = <R>(
  transition: ExternalEffect<never, R>,
  cancellable: boolean
): Effect.Effect<ReadonlyArray<Event>, never, EventLog | R> =>
  Effect.gen(function* () {
    const controller = abortController()
    const registry = yield* Effect.serviceOption(EffectInterruptions)
    const interrupts = interruptionOf(transition, cancellable)
    const unregister = interrupts === undefined || Option.isNone(registry)
      ? () => {}
      : registry.value.register(interrupts, controller)
    return yield* Effect.raceFirst(
      transition.act(transition.input, controller.signal),
      interruptedBy(controller.signal)
    ).pipe(
      Effect.catchCause((cause) =>
        controller.signal.aborted && Cause.hasInterruptsOnly(cause)
          ? Effect.succeed([])
          : Effect.failCause(cause)
      ),
      Effect.ensuring(Effect.sync(unregister))
    )
  })

// enabled returns derived transitions whose keys the log does not record.
export const enabled = <R>(a: Actor<R>, events: ReadonlyArray<Event>): ReadonlyArray<Transition<never, R>> => {
  const recorded = recordedKeys(events, a.keyOf)
  const continuations = a.reactors.flatMap((derive) => derive(events)).filter((transition) =>
    transition.invocation === undefined || !events.some((event, index) =>
      cancelsInvocation(event, transition.invocation!) &&
      (a.cancellationOf?.(events.slice(0, index), transition.invocation!) === "running" ||
        a.cancellationOf?.(events, transition.invocation!) === "running")
    )
  )
  const residuals = (a.cancellationResiduals?.(events) ?? []).map((transition) =>
    transition.kind === "effect" ? { ...transition, concurrent: true } : transition
  )
  return [...continuations, ...residuals].filter((transition) => !recorded.has(transition.key))
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
      const fire = (t: Transition<never, R>, sharedSnapshot = false) => Effect.gen(function* () {
        const before = yield* log.head
        const effectMark = t.kind === "effect" ? before : undefined
        const cancellable = t.invocation !== undefined &&
          a.cancellationOf?.(events, t.invocation) === "running"
        const attempted = t.kind === "intent"
          ? t.events(t.input, yield* Clock.currentTimeMillis)
          : yield* runExternalEffect(t, cancellable)
        const interrupts = t.kind === "effect" ? interruptionOf(t, cancellable) : undefined
        const returned = t.kind === "effect" && interrupts !== undefined &&
          (yield* log.readFrom(effectMark!)).some(interrupts)
          ? []
          : attempted
        if (returned.length > 0) yield* log.append(returned)
        const committed = recordedKeys(yield* log.read, a.keyOf).has(t.key)
        const outcome = committed
          ? "committed"
          : sharedSnapshot
            ? returned.length === 0 ? "blocked" : "wedged"
            : (yield* log.head) > before
              ? "advanced"
              : returned.length === 0
                ? "blocked"
                : "wedged"
        yield* Effect.annotateCurrentSpan("outcome", outcome)
        return { transition: t, outcome }
      }).pipe(
        Effect.withSpan("transition.fire", {
          attributes: { key: t.key, kind: t.kind },
          ...(trigger === undefined ? {} : { links: [{ span: trigger, attributes: {} }] })
        })
      )
      const concurrent = fires.filter((transition) => transition.kind === "effect" && transition.concurrent === true)
      let concurrentFired = false
      for (const t of fires) {
        if (t.kind === "effect" && t.concurrent === true) {
          if (concurrentFired) continue
          concurrentFired = true
          const before = yield* log.head
          const results = yield* Effect.all(
            concurrent.map((transition) => fire(transition, true)),
            { concurrency: "unbounded" }
          )
          const wedged = results.find((result) => result.outcome === "wedged")
          if (wedged !== undefined) {
            return yield* Effect.die(new Error(
              `${wedged.transition.kind} "${wedged.transition.key}" wedged: its events carry no committing key and none landed`
            ))
          }
          if (results.some((result) => result.outcome === "committed") || (yield* log.head) > before) {
            moved = true
            break
          }
          continue
        }
        const fired = yield* fire(t)
        if (fired.outcome === "committed" || fired.outcome === "advanced") {
          moved = true
          break
        } else if (fired.outcome === "wedged") {
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
