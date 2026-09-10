import { transitionKeyOf, transitionComponentIds } from "../transition/transition"
import type { Event } from "../event"
import type { InvocationRef } from "../interaction/invocation"
import { externalReplyKeys } from "../interaction/external-reply"
import type { ActorMethodCancellationState } from "../interaction/state"
import type { Projection } from "../projection/projection"
import type { ErasedTransitionProjection, Transition } from "../transition"

// Actor carries its runtime projection, validation guards, and durable key projection.
export interface Actor<R = never> {
  readonly projections: ReadonlyArray<ErasedTransitionProjection<R>>
  readonly guardProjections?: ReadonlyArray<ErasedTransitionProjection<R>>
  readonly keyOf: (e: Event) => string | undefined
  readonly cancellationOf?: (
    events: ReadonlyArray<Event>,
    invocation: InvocationRef
  ) => ActorMethodCancellationState | undefined
  readonly cancellationResiduals?: (
    events: ReadonlyArray<Event>
  ) => ReadonlyArray<Transition<never, R>> | undefined
  readonly projection?: ActorProjection<R>
}

// ActorProjectionOutput contains ordinary work and cancellation queries derived from actor state.
export interface ActorProjectionOutput<R = never> {
  readonly continuations: ReadonlyArray<Transition<never, R>>
  readonly cancellationOf: (invocation: InvocationRef) => ActorMethodCancellationState | undefined
  readonly suppresses: (invocation: InvocationRef) => boolean
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
}: ActorRuntimeOptions<R>): Actor<R> => {
  transitionComponentIds(transitions)
  return {
    projections: transitions,
    keyOf: (event) => transitionKeyOf(event) ?? externalReplyKeys.keyOf(event) ?? keyOf(event),
    ...(legacy?.cancellationOf === undefined ? {} : { cancellationOf: legacy.cancellationOf }),
    ...(legacy?.cancellationResiduals === undefined ? {} : { cancellationResiduals: legacy.cancellationResiduals }),
    ...(guards === undefined ? {} : { guardProjections: guards }),
    ...(control === undefined ? {} : { projection: control })
  }
}
