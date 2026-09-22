import { TRANSITION_COMPONENT_IDS } from "../transition/transition"
import type { KeyFragment } from "../log/keys"
import { COMPONENT_CONTRACT, type ComponentContract } from "../actor/contract"

declare const ComponentType: unique symbol

/**
 * Component is a named machine over an actor log.
 *
 * Its view composes with other components, its transitions describe owed work, and its keys identify the durable events that satisfy that work.
 *
 *   Component<View, Requirements, Result, Interactions>
 *             |       |              |          |
 *             |       |              |          +-- state-bound interactions
 *             |       |              +------------- response input
 *             |       +---------------------------- effect services
 *             +------------------------------------ composable view
 */
export interface Component<View, Requirements = never, Result = never, Interactions = unknown> {
  readonly name: string
  readonly [TRANSITION_COMPONENT_IDS]?: ReadonlyArray<string>
  readonly [ComponentType]: {
    readonly view: () => View
    readonly requirements: () => Requirements
    readonly interactions: () => Interactions
    readonly result: (result: Result) => void
  }
  readonly keys?: KeyFragment
  readonly [COMPONENT_CONTRACT]?: ComponentContract
}

// ComponentView extracts the public view exposed by a component.
export type ComponentView<C> = C extends Component<infer View, unknown> ? View : never

// ComponentRequirements extracts a component's service requirements.
export type ComponentRequirements<C> = C extends Component<unknown, infer R> ? R : never

// ComponentResult extracts the result accepted by a component's completion callbacks.
export type ComponentResult<C> = [C] extends [Component<unknown, unknown, infer Result>] ? Result : never

// ComponentInteractions extracts the state-dependent capabilities exposed by a component.
export type ComponentInteractions<C> = C extends Component<unknown, unknown, never, infer I> ? I : never

// ComponentViews retains each child's public view type in mount order.
export type ComponentViews<Cs extends ReadonlyArray<Component<unknown, unknown>>> = {
  readonly [K in keyof Cs]: ComponentView<Cs[K]>
}
