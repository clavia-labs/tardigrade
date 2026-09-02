import { Chunk } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import {
  materializeProjection,
  replayProjection,
  type MaterializedProjectionState,
  type Projection
} from "@clavia/tardigrade-core/projection"
import {
  eraseTransitionProjection,
  type ErasedTransitionProjection,
  type Transition
} from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log/keys"
import { COMPONENT_CONTRACT, type ComponentContract } from "../actor/contract"
import type { InvocationCancellation } from "../actor/method/cancellation"

export type { InvocationCancellation } from "../actor/method/cancellation"

// ComponentOutput contains one component's view and enabled transitions (tla/runtime/Projection.tla, ViewFaithful; tla/runtime/Reconcile.tla, NoVoid).
export interface ComponentOutput<View, Requirements = never> {
  readonly view: View
  readonly transitions: ReadonlyArray<Transition<never, Requirements>>
}

// ComponentMachine erases private component state while preserving its Moore-style machine contract.
export interface ComponentMachine<View, Requirements = never>
  extends Projection<unknown, ComponentOutput<View, Requirements>> {
  readonly cancel?: (
    state: unknown,
    cancellation: InvocationCancellation
  ) => ReadonlyArray<Transition<never, Requirements>>
}

/**
 * Component is a named machine over an actor log.
 *
 * Its view composes with other components, its transitions describe owed work, and its keys identify the durable events that satisfy that work.
 */
export interface Component<View, Requirements = never> {
  readonly name: string
  readonly machine: ComponentMachine<View, Requirements>
  readonly keys?: KeyFragment
  readonly [COMPONENT_CONTRACT]?: ComponentContract
}

// IncrementalComponentDefinition is the typed author surface for an incremental component machine.
export interface IncrementalComponentDefinition<State, View, Requirements = never>
  extends Projection<State, ComponentOutput<View, Requirements>> {
  readonly name: string
  readonly cancelState?: (
    state: State,
    cancellation: InvocationCancellation
  ) => ReadonlyArray<Transition<never, Requirements>>
  readonly keys?: KeyFragment
  readonly [COMPONENT_CONTRACT]?: ComponentContract
}

// LegacyComponentDefinition is the complete-history author surface retained for migration.
export interface LegacyComponentDefinition<View, Requirements = never> {
  readonly name: string
  readonly derive: (log: ReadonlyArray<Event>) => ComponentOutput<View, Requirements>
  readonly cancel?: (
    log: ReadonlyArray<Event>,
    cancellation: InvocationCancellation
  ) => ReadonlyArray<Transition<never, Requirements>>
  readonly keys?: KeyFragment
  readonly [COMPONENT_CONTRACT]?: ComponentContract
}

const eraseMachine = <State, View, Requirements>(
  definition: IncrementalComponentDefinition<State, View, Requirements>
): ComponentMachine<View, Requirements> => {
  const cancelState = definition.cancelState
  const projection = materializeProjection<State, ComponentOutput<View, Requirements>>({
    initial: definition.initial,
    step: definition.step,
    output: definition.output
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
            cancelState((state as CachedState).state, cancellation)
        })
  }
}

// incrementalComponent constructs a materialized component machine.
export const incrementalComponent = <State, View, Requirements = never>(
  definition: IncrementalComponentDefinition<State, View, Requirements>
): Component<View, Requirements> => ({
  name: definition.name,
  machine: eraseMachine(definition),
  ...(definition.keys === undefined ? {} : { keys: definition.keys }),
  ...(definition[COMPONENT_CONTRACT] === undefined ? {} : { [COMPONENT_CONTRACT]: definition[COMPONENT_CONTRACT] })
})

// legacyComponent adapts a complete-history definition by retaining its event log as machine state.
export const legacyComponent = <View, Requirements = never>(
  definition: LegacyComponentDefinition<View, Requirements>
): Component<View, Requirements> => {
  const cancel = definition.cancel
  return {
    name: definition.name,
    machine: {
      initial: () => Chunk.empty<Event>(),
      step: (events, event) => Chunk.append(events as Chunk.Chunk<Event>, event),
      output: (events) => definition.derive(Chunk.toReadonlyArray(events as Chunk.Chunk<Event>)),
      ...(cancel === undefined
        ? {}
        : {
            cancel: (events: unknown, cancellation: InvocationCancellation) =>
              cancel(Chunk.toReadonlyArray(events as Chunk.Chunk<Event>), cancellation)
          })
    },
    ...(definition.keys === undefined ? {} : { keys: definition.keys }),
    ...(definition[COMPONENT_CONTRACT] === undefined ? {} : { [COMPONENT_CONTRACT]: definition[COMPONENT_CONTRACT] })
  }
}

// deriveComponent replays complete history through a component machine.
export const deriveComponent = <View, Requirements>(
  component: Component<View, Requirements>,
  log: ReadonlyArray<Event>
): ComponentOutput<View, Requirements> => replayProjection(component.machine, log)

// cancelComponent replays complete history before asking a component for cancellation work.
export const cancelComponent = <View, Requirements>(
  component: Component<View, Requirements>,
  log: ReadonlyArray<Event>,
  cancellation: InvocationCancellation
): ReadonlyArray<Transition<never, Requirements>> => {
  const cancel = component.machine.cancel
  if (cancel === undefined) return []
  const state = log.reduce(component.machine.step, component.machine.initial())
  return cancel(state, cancellation)
}

// ComponentRequirements extracts a component's service requirements.
export type ComponentRequirements<C> = C extends Component<unknown, infer R> ? R : never

// transitionProjectionOf exposes a component's enabled work as a transition projection.
export const transitionProjectionOf = <V, R>(component: Component<V, R>): ErasedTransitionProjection<R> =>
  eraseTransitionProjection({
    initial: component.machine.initial,
    step: component.machine.step,
    output: (state) => component.machine.output(state).transitions
  })
