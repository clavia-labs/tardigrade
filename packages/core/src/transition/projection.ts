import type { Event } from "@clavia/tardigrade-core/event"
import type { Projection } from "@clavia/tardigrade-core/projection"
import type { Transition } from "./transition"

// CompleteTransitionDerivation derives enabled work from complete event history.
export type CompleteTransitionDerivation<Requirements = never> = (
  events: ReadonlyArray<Event>
) => ReadonlyArray<Transition<never, Requirements>>

/**
 * TransitionProjection derives enabled work from incrementally maintained event state.
 *
 *   TransitionProjection<State, Requirements>
 *                        │          │
 *                        │          └─ services its effects may require
 *                        └──────────── event history remembered by the projection
 */
export interface TransitionProjection<State, Requirements = never>
  extends Projection<State, ReadonlyArray<Transition<never, Requirements>>> {}

// ErasedTransitionProjection preserves a transition projection in heterogeneous runtime collections.
export interface ErasedTransitionProjection<Requirements = never> {
  readonly initial: () => unknown
  readonly step: {
    bivarianceHack(state: unknown, event: Event): unknown
  }["bivarianceHack"]
  readonly output: {
    bivarianceHack(state: unknown): ReadonlyArray<Transition<never, Requirements>>
  }["bivarianceHack"]
}

// transitionProjection preserves state inference for a transition projection definition.
export const transitionProjection = <State, Requirements = never>(
  definition: TransitionProjection<State, Requirements>
): TransitionProjection<State, Requirements> => definition

// eraseTransitionProjection hides private projection state from heterogeneous runtime collections.
export const eraseTransitionProjection = <State, Requirements = never>(
  projection: TransitionProjection<State, Requirements>
): ErasedTransitionProjection<Requirements> => ({
  initial: projection.initial,
  step: (state, event) => projection.step(state as State, event),
  output: (state) => projection.output(state as State)
})

// completeTransitionProjection adapts complete-history transition derivation by retaining history as projection state.
export const completeTransitionProjection = <Requirements = never>(
  derive: CompleteTransitionDerivation<Requirements>
): ErasedTransitionProjection<Requirements> => ({
  initial: () => [],
  step: (events, event) => [...events as ReadonlyArray<Event>, event],
  output: (events) => derive(events as ReadonlyArray<Event>)
})
