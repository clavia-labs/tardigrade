import type { Event } from "@clavia/tardigrade-core/event"
import type { Machine } from "@clavia/tardigrade-core/machine"

/**
 * Projection specializes Machine to Event input.
 * Replaying step from initial must produce the state observed by output
 * See Projection Algebra (tla/runtime/ProjectionAlgebra.tla, ReducerLaw).
 *
 *   Projection<State, Value>
 *              │      │
 *              │      └─ what can be observed
 *              └──────── what event history is remembered as
 */
export type Projection<State, Value> = Machine<Event, State, Value>

/**
 * replayProjection reconstructs a projection value from complete event history.
 *
 *   State₀ = projection.initial()
 *   Stateₙ₊₁ = projection.step(Stateₙ, Eventₙ₊₁)
 *   Value = projection.output(finalState)
 *
 * It supports cold reconstruction, refinement tests, and legacy compatibility.
 * Incremental execution retains the reached state and steps only the new event tail.
 */
export const replayProjection = <State, Value>(
  projection: Projection<State, Value>,
  events: ReadonlyArray<Event>
): Value => projection.output(events.reduce(projection.step, projection.initial()))

// MaterializedProjectionState pairs projection state with the value derived from that state.
export interface MaterializedProjectionState<State, Value> {
  readonly state: State
  readonly value: Value
}

/**
 * materializeProjection stores a projection's output and recomputes it when state identity changes.
 *
 * The projection author uses identity as the cache invalidation signal:
 *
 *   step: (state, event) => {
 *     if (eventDoesNotMatter(event)) {
 *       return state
 *     }
 *     return computeNextState(state, event)
 *   }
 *
 * Returning state reuses the cached output. Returning a new state recomputes it.
 *
 * Step must not mutate and return its existing state.
 * Doing so changes the projection without invalidating its cached output
 * (projection.test.ts, "materialization reuses the value while state identity is stable").
 */
export const materializeProjection = <State, Value>(
  projection: Projection<State, Value>
): Projection<MaterializedProjectionState<State, Value>, Value> => ({
  initial: () => {
    const state = projection.initial()
    return { state, value: projection.output(state) }
  },
  step: (current, event) => {
    const state = projection.step(current.state, event)
    return Object.is(state, current.state)
      ? current
      : { state, value: projection.output(state) }
  },
  output: (current) => current.value
})
