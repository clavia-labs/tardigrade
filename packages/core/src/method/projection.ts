import type { Projection } from "@clavia/tardigrade-core/projection"
import type { ActorMethodView } from "./view"

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
