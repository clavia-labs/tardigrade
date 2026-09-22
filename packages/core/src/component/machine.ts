import { Context } from "effect"
import { createMachine } from "./composition/parent"
import { registerComponent } from "./runtime"
import { composeKeys } from "../log/keys"
import type { Event } from "../event"
import { transitionComponentIds, TRANSITION_COMPONENT_IDS, type TransitionContext } from "../transition/transition"
import type { Projection } from "@clavia/tardigrade-core/projection"
import { COMPONENT_CONTRACT, mergeComponentContracts, type ComponentContract } from "../actor/contract"
import type { Component, ComponentRequirements } from "./component"
import type { ComponentOutput } from "./output"
import type { ChildOf, ComponentChildren } from "./composition/children"

export type { TransitionContext } from "../transition/transition"
export type { InvocationCancellation } from "../interaction/events"

/**
 * ComponentMachine erases private component state while preserving its Moore-style machine contract.
 *
 *   ComponentMachine
 *     ├── initial()
 *     ├── step(state, event)
 *     └── output(state)
 *           ├── view
 *           ├── transitions (with respond)
 *           └── interactions
 *                 └── cancel?(cancellation)
 *
 * Cancellation is an optional state query that derives cleanup transitions for one invocation.
 */
export interface ComponentMachine<View, Requirements = never, Result = never, Interactions = unknown>
  extends Projection<unknown, ComponentOutput<View, Requirements, Result, Interactions>> {}

// ComponentDependencies names data services bound when a component snapshot is initialized.
export type ComponentDependencies = ReadonlyArray<Context.Key<unknown, unknown>>
export type ComponentData<D extends ComponentDependencies> = { readonly [K in keyof D]: Context.Service.Shape<D[K]> }
export type ComponentDataRequirements<D extends ComponentDependencies> = Context.Service.Identifier<D[number]>
type ChildRequirements<C extends ComponentChildren> = ComponentRequirements<C extends ReadonlyArray<unknown> ? C[number] : C>

// ComponentDefinition is the typed author surface for a component machine.
export interface ComponentDefinition<State, View, Requirements = never, Result = unknown, Children extends ComponentChildren = readonly [], Dependencies extends ComponentDependencies = readonly [], Interactions = unknown> {
  readonly name: string
  readonly children?: Children
  readonly dependencies?: Dependencies
  readonly initial: (children: ChildOf<Children>, data: ComponentData<Dependencies>) => State
  readonly step: (state: Readonly<State>, event: Event, context: TransitionContext, children: ChildOf<Children>, previous: ChildOf<Children>) => State
  readonly output: (state: Readonly<State>, children: ChildOf<Children>) => ComponentOutput<View, Requirements, Result, Interactions>
  readonly [COMPONENT_CONTRACT]?: ComponentContract
}

// component constructs a named, materialized component machine. Complete-log definitions use legacyComponent.
export const component = <State, View, Requirements = never, Result = unknown, const Children extends ComponentChildren = readonly [], const Dependencies extends ComponentDependencies = readonly [], Interactions = unknown>(
  definition: ComponentDefinition<State, View, Requirements, Result, Children, Dependencies, Interactions>
): Component<View, Requirements | ComponentDataRequirements<Dependencies> | ChildRequirements<Children>, Result, Interactions> => {
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
  const members: ReadonlyArray<Component<unknown, unknown>> = definition.children === undefined ? [] : Array.isArray(definition.children) ? [...definition.children] : [definition.children as Component<unknown, unknown>]
  const identities = transitionComponentIds([{ [TRANSITION_COMPONENT_IDS]: [definition.name] }, ...members])
  const fragments = members.flatMap((child) => child.keys === undefined ? [] : [child.keys])
  const inherited = mergeComponentContracts(members)
  const own = definition[COMPONENT_CONTRACT]
  return registerComponent({
    name: definition.name,
    [TRANSITION_COMPONENT_IDS]: identities,
    ...(fragments.length === 0 ? {} : { keys: {
      prefixes: fragments.flatMap((fragment) => fragment.prefixes),
      keyOf: composeKeys(...fragments)
    } }),
    [COMPONENT_CONTRACT]: {
      handles: [...inherited.handles, ...(own?.handles ?? [])],
      calls: [...inherited.calls, ...(own?.calls ?? [])]
    }
  }, createMachine(definition, members, identities))
}
