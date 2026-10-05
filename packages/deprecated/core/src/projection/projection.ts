import { Context } from "effect"
import { eventAt, eventPositionOf, type Event } from "@clavia/tardigrade-deprecated-core/event"
import type { Machine } from "@clavia/tardigrade-deprecated-core/machine"

/**
 * Projection specializes Machine to Event input.
 * Replaying step from initial must produce the state observed by output
 * See Projection Algebra (tla/projection/ProjectionAlgebra.tla, ReducerLaw).
 *
 *   Projection<State, Value>
 *              │      │
 *              │      └─ what can be observed
 *              └──────── what event history is remembered as
 */
export interface Projection<State, Value> extends Machine<Event, State, Value> {
  readonly initial: (data?: Context.Context<never>) => State
}

// replayState reconstructs a snapshot while preserving recorded event positions (projection.test.ts).
export const replayState = <State>(
  projection: Pick<Projection<State, unknown>, "initial" | "step">,
  events: ReadonlyArray<Event>,
  data?: Context.Context<never>
): State => events.reduce(
  (state, event, index) => projection.step(state, eventAt(event, eventPositionOf(event) ?? index + 1)),
  projection.initial(data)
)

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
  events: ReadonlyArray<Event>,
  data?: Context.Context<never>
): Value => projection.output(replayState(projection, events, data))

// MaterializedProjectionState pairs projection state with the value derived from that state.
export interface MaterializedProjectionState<State, Value> {
  readonly state: State
  readonly value: Value
}

/**
 * materializeProjection memoizes output on first observation of each state identity.
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
 * Returning state reuses the cached output. A new state computes output when observed.
 * An output that throws therefore throws at its first read, not at the step that reached the state.
 *
 * Step must not mutate and return its existing state.
 * Doing so changes the projection without invalidating its cached output
 * (projection.test.ts, "materialization reuses the value while state identity is stable").
 */
// derived holds each materialized state whose output was read, so a holder of an old state can resolve from it and release it.
const derived = new WeakSet<object>()

// outputDerived reports whether a materialized state's output was already read; reading it again costs nothing.
export const outputDerived = (state: unknown): boolean => typeof state === "object" && state !== null && derived.has(state)

export const materializeProjection = <State, Value>(
  projection: Projection<State, Value>
): Projection<MaterializedProjectionState<State, Value>, Value> => {
  const defer = (state: State): MaterializedProjectionState<State, Value> => {
    let cached: { readonly value: Value } | undefined
    const materialized: MaterializedProjectionState<State, Value> = {
      state,
      get value() {
        if (cached === undefined) {
          cached = { value: projection.output(state) }
          derived.add(materialized)
        }
        return cached.value
      }
    }
    return materialized
  }
  return {
    initial: (data) => defer(projection.initial(data)),
    step: (current, event) => {
      const state = projection.step(current.state, event)
      return Object.is(state, current.state) ? current : defer(state)
    },
    output: (current) => current.value
  }
}
