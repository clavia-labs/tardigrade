import type { Event } from "../event"
import { bindTransitionContext, validateTransitions, transitionComponentIds, TRANSITION_COMPONENT_IDS, type TransitionContext } from "../transition/transition"
import {
  materializeProjection,
  type MaterializedProjectionState,
  type Projection
} from "@clavia/tardigrade-core/projection"
import type { Transition } from "@clavia/tardigrade-core/transition"
import { COMPONENT_CONTRACT, type ComponentContract } from "../actor/contract"
import type { InvocationCancellation } from "../interaction/events"
import type { Component } from "./component"
import type { ComponentOutput } from "./output"

export type { TransitionContext } from "../transition/transition"

export type { InvocationCancellation } from "../interaction/events"

/**
 * ComponentMachine erases private component state while preserving its Moore-style machine contract.
 *
 *   ComponentMachine
 *     ├── initial()
 *     ├── step(state, event)
 *     ├── output(state)
 *     └── cancel?(state, cancellation)
 *
 * Cancellation is an optional state query that derives cleanup transitions for one invocation.
 */
export interface ComponentMachine<View, Requirements = never>
  extends Projection<unknown, ComponentOutput<View, Requirements>> {
  readonly cancel?: (
    state: unknown,
    cancellation: InvocationCancellation
  ) => ReadonlyArray<Transition<never, Requirements>>
}

// ComponentDefinition is the typed author surface for a component machine.
export interface ComponentDefinition<State, View, Requirements = never>
  extends Omit<Projection<State, ComponentOutput<View, Requirements>>, "step"> {
  readonly name: string
  // children declares the component identities this wrapper may forward (transition/migration.test.ts).
  readonly children?: ReadonlyArray<Component<unknown, unknown>>
  readonly step: (state: State, event: Event, context: TransitionContext) => State
  readonly cancelState?: (
    state: State,
    cancellation: InvocationCancellation
  ) => ReadonlyArray<Transition<never, Requirements>>
  readonly [COMPONENT_CONTRACT]?: ComponentContract
}

const eraseMachine = <State, View, Requirements>(
  definition: ComponentDefinition<State, View, Requirements>,
  identities: ReadonlyArray<string>
): ComponentMachine<View, Requirements> => {
  const cancelState = definition.cancelState
  const identity = definition.name
  const projection = materializeProjection<State, ComponentOutput<View, Requirements>>({
    initial: definition.initial,
    step: (state, event) => definition.step(state, event, bindTransitionContext(event, identity)),
    output: (state) => {
      const output = definition.output(state)
      validateTransitions(output.transitions, identities)
      return output
    }
  })
  type CachedState = MaterializedProjectionState<State, ComponentOutput<View, Requirements>>
  return {
    initial: projection.initial,
    step: (state, event) => projection.step(state as CachedState, event),
    output: (state) => projection.output(state as CachedState),
    ...(cancelState === undefined
      ? {}
      : {
          cancel: (state: unknown, cancellation: InvocationCancellation) =>
            validateTransitions(cancelState((state as CachedState).state, cancellation), identities)
        })
  }
}

// component constructs a named, materialized component machine. Complete-log definitions use legacyComponent.
export const component = <State, View, Requirements = never>(
  definition: ComponentDefinition<State, View, Requirements>
): Component<View, Requirements> => {
  if (
    typeof definition.initial !== "function" ||
    typeof definition.step !== "function" ||
    typeof definition.output !== "function"
  ) {
    throw new TypeError(
      `component "${definition.name}" requires initial, step, and output; use legacyComponent for derive(log) definitions`
    )
  }
  if (typeof definition.name !== "string" || definition.name.length === 0) throw new Error("components require a nonempty name")
  const identities = transitionComponentIds([{ [TRANSITION_COMPONENT_IDS]: [definition.name] }, ...(definition.children ?? [])])
  return {
    name: definition.name,
    [TRANSITION_COMPONENT_IDS]: identities,
    machine: eraseMachine(definition, identities),
    ...(definition[COMPONENT_CONTRACT] === undefined ? {} : { [COMPONENT_CONTRACT]: definition[COMPONENT_CONTRACT] })
  }
}

/** @deprecated Use component. The primary component constructor now accepts the same state-machine definition. */
export const incrementalComponent = <State, View, Requirements = never>(
  definition: ComponentDefinition<State, View, Requirements>
): Component<View, Requirements> => component(definition)

/** @deprecated Use ComponentDefinition. The primary definition now describes the state-machine component contract. */
export type IncrementalComponentDefinition<State, View, Requirements = never> = ComponentDefinition<State, View, Requirements>
