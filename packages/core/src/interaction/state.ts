import type { Event } from "../event"
import type { ActorMethods, ActorMethodDeclaration } from "../actor/method"
import type { Projection } from "../projection/projection"
import type { InvocationRef } from "./invocation"

// ActorMethodState reports whether an invocation is awaiting its single terminal response or has produced it (tla/interaction/Method.tla, AtMostOneResponsePerCall).
export type ActorMethodState<Output> =
  | { readonly status: "pending" }
  | { readonly status: "completed"; readonly output: Output; readonly data?: unknown }
  | { readonly status: "failed"; readonly error: string; readonly data?: unknown }
  | {
      readonly status: "cancelled"
      readonly cause: "requested" | "deadline"
      readonly reason?: string
      readonly deadlineAt?: number
      readonly data?: unknown
    }

export type ActorMethodCancellationState = "running" | "cancelled" | "terminal"

/**
 * ActorMethodView exposes invocation lifecycle queries derived from one projected history.
 *
 *   ActorMethodView<Output>
 *                   │
 *                   └─ value returned by a completed invocation
 *
 *   ActorMethodView
 *     ├── currentEpoch(id)
 *     ├── invocationState(invocation)
 *     └── cancellationState?(invocation)
 */
export interface ActorMethodView<Output = unknown> {
  readonly currentEpoch: (id: string) => number
  readonly invocationState: (invocation: InvocationRef) => ActorMethodState<Output> | undefined
  readonly cancellationState?: (invocation: InvocationRef) => ActorMethodCancellationState | undefined
}

/**
 * ActorMethodProjection is a projection whose output answers lifecycle queries for every invocation of one method.
 *
 *   ActorMethodProjection<State, Output>
 *                         │      │
 *                         │      └─ completed invocation value
 *                         └──── method history remembered by the projection
 */
export interface ActorMethodProjection<State, Output = unknown>
  extends Projection<State, ActorMethodView<Output>> {}

// ErasedActorMethodProjection preserves a method projection inside heterogeneous method tables.
export interface ErasedActorMethodProjection
  extends Projection<unknown, ActorMethodView<unknown>> {}

// eraseActorMethodProjection hides private method state from heterogeneous method tables.
export const eraseActorMethodProjection = <State, Output>(
  projection: ActorMethodProjection<State, Output>
): ErasedActorMethodProjection => ({
  initial: projection.initial,
  step: (state, event) => projection.step(state as State, event),
  output: (state) => projection.output(state as State)
})

// initialMethodStates constructs private projection state for every method.
export const initialMethodStates = (methods: ActorMethods): ReadonlyMap<string, unknown> =>
  new Map(Object.entries(methods).map(([name, method]) => [name, method.projection.initial()]))

// reduceMethodStates advances every method projection with one event.
export const reduceMethodStates = (
  methods: ActorMethods,
  states: ReadonlyMap<string, unknown>,
  event: Event
): ReadonlyMap<string, unknown> => new Map(Object.entries(methods).map(([name, method]) => [
  name,
  method.projection.step(states.get(name), event)
]))

// cancellationStateOf reports cancellation progress from the method view.
export const cancellationStateOf = (
  method: ActorMethodDeclaration | undefined,
  view: ActorMethodView<unknown> | undefined,
  invocation: InvocationRef
): ActorMethodCancellationState | undefined => {
  if (method?.cancellation === undefined || view === undefined) return undefined
  if (view.cancellationState !== undefined) return view.cancellationState(invocation)
  const state = view.invocationState(invocation)
  if (state === undefined) return undefined
  if (state.status === "pending") return "running"
  if (state.status === "cancelled") return "cancelled"
  return "terminal"
}
