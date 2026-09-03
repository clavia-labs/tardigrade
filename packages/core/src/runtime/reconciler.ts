import { Cause, Clock, Context, Effect, Option, type Tracer } from "effect"
import type { ActorInvocation, ActorMethodCancellationState } from "@clavia/tardigrade-core/method"
import { cancelsInvocation } from "@clavia/tardigrade-core/method/cancellation"
import type { ThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import type { ExternalEffect } from "@clavia/tardigrade-core/effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog } from "@clavia/tardigrade-core/log"
import { linkOf } from "@clavia/tardigrade-core/log/trace"
import type { Projection } from "@clavia/tardigrade-core/projection"
import type { ErasedTransitionProjection, Transition } from "@clavia/tardigrade-core/transition"

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

// Actor carries its runtime projection, validation guards, and durable key projection.
export interface Actor<R = never> {
  readonly projections: ReadonlyArray<ErasedTransitionProjection<R>>
  readonly guardProjections?: ReadonlyArray<ErasedTransitionProjection<R>>
  readonly keyOf: (e: Event) => string | undefined
  readonly cancellationOf?: (
    events: ReadonlyArray<Event>,
    invocation: ActorInvocation
  ) => ActorMethodCancellationState | undefined
  readonly cancellationResiduals?: (
    events: ReadonlyArray<Event>
  ) => ReadonlyArray<Transition<never, R>> | undefined
  readonly projection?: ActorProjection<R>
}

// ActorProjectionOutput contains ordinary work and cancellation queries derived from actor state.
export interface ActorProjectionOutput<R = never> {
  readonly continuations: ReadonlyArray<Transition<never, R>>
  readonly cancellationOf: (invocation: ActorInvocation) => ActorMethodCancellationState | undefined
  readonly suppresses: (invocation: ActorInvocation) => boolean
  readonly residuals: ReadonlyArray<Transition<never, R>> | undefined
}

// ActorProjection derives the runtime behavior of an actor from its event stream.
export interface ActorProjection<R = never> extends Projection<unknown, ActorProjectionOutput<R>> {}

// ActorRuntimeOptions names the transition, guard, and control projections supplied to an actor runtime.
export interface ActorRuntimeOptions<R = never> {
  readonly transitions: ReadonlyArray<ErasedTransitionProjection<R>>
  readonly keyOf: Actor<R>["keyOf"]
  readonly guards?: ReadonlyArray<ErasedTransitionProjection<R>>
  readonly control?: ActorProjection<R>
  // legacy carries complete-log cancellation callbacks for compatibility actors.
  readonly legacy?: {
    readonly cancellationOf?: Actor<R>["cancellationOf"]
    readonly cancellationResiduals?: Actor<R>["cancellationResiduals"]
  }
}

// actorFromProjections constructs the runtime surface from transition projections.
export const actorFromProjections = <R = never>({
  transitions,
  keyOf,
  guards,
  control,
  legacy
}: ActorRuntimeOptions<R>): Actor<R> => ({
  projections: transitions,
  keyOf,
  ...(legacy?.cancellationOf === undefined ? {} : { cancellationOf: legacy.cancellationOf }),
  ...(legacy?.cancellationResiduals === undefined ? {} : { cancellationResiduals: legacy.cancellationResiduals }),
  ...(guards === undefined ? {} : { guardProjections: guards }),
  ...(control === undefined ? {} : { projection: control })
})

const recordedKeys = (events: ReadonlyArray<Event>, keyOf: Actor["keyOf"]): Set<string> => {
  const keys = new Set<string>()
  for (const e of events) {
    const key = keyOf(e)
    if (key !== undefined) keys.add(key)
  }
  return keys
}

interface ProjectionCache<R> {
  // TODO: Remove complete-log retention after compatibility cancellation callbacks no longer require replay.
  readonly events: Array<Event>
  readonly recorded: Set<string>
  readonly states: Map<ErasedTransitionProjection<R>, unknown>
  readonly actorState: unknown
  readonly trigger: Tracer.ExternalSpan | undefined
  readonly watermark: number
}

// advanceCache publishes a complete next cache after every projection accepts the tail (runtime/incremental-reconciler.properties.test.ts, "a failed tail update retries from the published prefix").
const advanceCache = <R>(a: Actor<R>, cache: ProjectionCache<R>, events: ReadonlyArray<Event>): ProjectionCache<R> => {
  const recorded = new Set(cache.recorded)
  const states = new Map(cache.states)
  let actorState = cache.actorState
  let trigger = cache.trigger
  for (const event of events) {
    const key = a.keyOf(event)
    if (key !== undefined) recorded.add(key)
    trigger = linkOf(event) ?? trigger
    for (const projection of a.projections) {
      states.set(projection, projection.step(states.get(projection), event))
    }
    if (a.projection !== undefined) actorState = a.projection.step(actorState, event)
  }
  for (const event of events) cache.events.push(event)
  return {
    events: cache.events,
    recorded,
    states,
    actorState,
    trigger,
    watermark: cache.watermark + events.length
  }
}

const projectionCache = <R>(a: Actor<R>, events: ReadonlyArray<Event>): ProjectionCache<R> => {
  const cache: ProjectionCache<R> = {
    events: [],
    recorded: new Set(),
    states: new Map(),
    actorState: a.projection?.initial(),
    trigger: undefined,
    watermark: 0
  }
  for (const projection of a.projections) {
    cache.states.set(projection, projection.initial())
  }
  return advanceCache(a, cache, events)
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
  const states = new Map<ErasedTransitionProjection<R>, unknown>()
  let actorState = a.projection?.initial()
  for (const projection of a.projections) {
    let state = projection.initial()
    for (const event of events) state = projection.step(state, event)
    states.set(projection, state)
  }
  if (a.projection !== undefined) {
    for (const event of events) actorState = a.projection.step(actorState, event)
  }
  return enabledFrom(a, events, recorded, states, actorState)
}

const enabledFrom = <R>(
  a: Actor<R>,
  events: ReadonlyArray<Event>,
  recorded: ReadonlySet<string>,
  states: ReadonlyMap<ErasedTransitionProjection<R>, unknown>,
  actorState: unknown
): ReadonlyArray<Transition<never, R>> => {
  const guards = (a.guardProjections ?? []).flatMap((projection) => projection.output(states.get(projection)))
    .filter((transition) => !recorded.has(transition.key))
  const guarded = new Set(a.guardProjections ?? [])
  const actorOutput = a.projection?.output(actorState)
  const continuations = (guards.length > 0
    ? guards
    : [
        ...a.projections.flatMap((projection) =>
          guarded.has(projection) ? [] : projection.output(states.get(projection))),
        ...(actorOutput?.continuations ?? [])
      ]).filter((transition) => {
    if (transition.invocation === undefined) return true
    const suppressed = a.projection === undefined
      ? events.some((event, index) =>
          cancelsInvocation(event, transition.invocation!) &&
          (a.cancellationOf?.(events.slice(0, index), transition.invocation!) === "running" ||
            a.cancellationOf?.(events, transition.invocation!) === "running")
        )
      : actorOutput!.suppresses(transition.invocation)
    return !suppressed
  })
  const residualTransitions = a.projection === undefined
    ? a.cancellationResiduals?.(events)
    : actorOutput!.residuals
  const residuals = (residualTransitions ?? []).map((transition) =>
    transition.kind === "effect" ? { ...transition, concurrent: true } : transition
  )
  return [...continuations, ...residuals].filter((transition) => !recorded.has(transition.key))
}

// restingActor reports whether the log enables no transition
// (tla/runtime/Driver.tla, Accounting).
export const restingActor = <R>(a: Actor<R>, events: ReadonlyArray<Event>): boolean =>
  enabled(a, events).length === 0

// settleActor attempts enabled transitions until the actor rests. Any log movement starts a fresh
// output before another transition fires (actor.properties.test.ts, "a committed intent
// invalidates every remaining transition from its snapshot"; tla/runtime/Coherence.tla,
// NoSuppressedCommit). A fire may commit, advance, block, or wedge; a wedge dies, and the platform
// alarm re-drives blocked work (tla/runtime/Driver.tla, EventuallyServed).
export interface ActorReconciler<R> {
  readonly settle: Effect.Effect<void, never, EventLog | R>
  // isResting reports the result of the last completed settlement. A host must also account for work appended since that settlement.
  readonly isResting: () => boolean
}

// createActorReconciler retains a sound projection and advances it from the durable watermark.
// One instance belongs to one actor activation (tla/runtime/IncrementalProjection.tla, CacheSound).
export const createActorReconciler = <R>(a: Actor<R>): ActorReconciler<R> => {
  let cache: ProjectionCache<R> | undefined
  let resting = false
  const synchronize = (log: Context.Service.Shape<typeof EventLog>) => Effect.gen(function* () {
    if (cache === undefined) {
      cache = projectionCache(a, yield* log.read)
      return cache
    }
    cache = advanceCache(a, cache, yield* log.readFrom(cache.watermark))
    return cache
  })
  return { settle: Effect.gen(function* () {
    resting = false
    const log = yield* EventLog
    while (true) {
      const current = yield* synchronize(log)
      const events = current.events
      const fires = enabledFrom(a, events, current.recorded, current.states, current.actorState)
      if (fires.length === 0) {
        resting = true
        return
      }
      const trigger = current.trigger
      let moved = false
      const fire = (t: Transition<never, R>, sharedSnapshot = false) => Effect.gen(function* () {
        const before = yield* log.head
        if (before !== current.watermark) {
          yield* Effect.annotateCurrentSpan("outcome", "advanced")
          return { transition: t, outcome: "advanced" as const }
        }
        const effectMark = t.kind === "effect" ? before : undefined
        const cancellable = t.invocation !== undefined &&
          (a.projection === undefined
            ? a.cancellationOf?.(events, t.invocation)
            : a.projection.output(current.actorState).cancellationOf(t.invocation)) === "running"
        const attempted = t.kind === "intent"
          ? t.events(t.input, yield* Clock.currentTimeMillis)
          : yield* runExternalEffect(t, cancellable)
        const interrupts = t.kind === "effect" ? interruptionOf(t, cancellable) : undefined
        const returned = t.kind === "effect" && interrupts !== undefined &&
          (yield* log.readFrom(effectMark!)).some(interrupts)
          ? []
          : attempted
        if (returned.length > 0) yield* log.append(returned)
        const tail = yield* log.readFrom(before)
        const committed = current.recorded.has(t.key) || tail.some((event) => a.keyOf(event) === t.key)
        const outcome = committed
          ? "committed"
          : sharedSnapshot
            ? returned.length === 0 ? "blocked" : "wedged"
            : tail.length > 0
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
  }), isResting: () => resting }
}

// settleActor attempts enabled transitions with a cursor scoped to this settlement.
export const settleActor = <R>(a: Actor<R>): Effect.Effect<void, never, EventLog | R> =>
  createActorReconciler(a).settle

// send appends one event and settles the actor.
export const send = <R>(a: Actor<R>, event: Event): Effect.Effect<void, never, EventLog | R> =>
  Effect.gen(function* () {
    const log = yield* EventLog
    yield* log.append([event])
    yield* settleActor(a)
  })
