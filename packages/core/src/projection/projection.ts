import type { Event } from "@clavia/tardigrade-core/event"
import type { Machine } from "@clavia/tardigrade-core/machine"

// Projection specializes Machine to event input. Replaying step from initial must produce the state observed by output (tla/runtime/ProjectionAlgebra.tla, ReducerLaw).
export type Projection<State, Value> = Machine<Event, State, Value>

// MaterializedProjectionState pairs projection state with the value derived from that state.
export interface MaterializedProjectionState<State, Value> {
  readonly state: State
  readonly value: Value
}

// materializeProjection caches the output while step preserves state identity. Step must return a new identity whenever output may change.
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

// replayProjection derives a projection value from complete history.
export const replayProjection = <State, Value>(
  projection: Projection<State, Value>,
  events: ReadonlyArray<Event>
): Value => projection.output(events.reduce(projection.step, projection.initial()))
