import type { Event } from "@clavia/tardigrade-core/event"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import {
  eraseTransitionProjection,
  type ErasedTransitionProjection,
  type Transition
} from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log/keys"
import { COMPONENT_CONTRACT, type ComponentContract } from "../actor/contract"
import type { InvocationCancellation } from "../method/cancellation"
import type { ComponentMachine } from "./machine"
import type { ComponentOutput } from "./output"

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
