import { Context } from "effect"
import { eventPositionOf, type Event } from "../../event"
import { machineOf } from "../runtime"
import { bindTransitionContext, validateTransitions } from "../../transition/transition"
import { materializeProjection, type MaterializedProjectionState } from "@clavia/tardigrade-core/projection"
import type { Component } from "../component"
import type { ComponentOutput } from "../output"
import type { ComponentDefinition, ComponentMachine, ComponentDependencies, ComponentData, ComponentDataRequirements } from "../machine"
import { bindChild, type ChildOf, type ComponentChildren } from "./children"

// createMachine manages private snapshots and bound child lifecycles (children.test.ts).
export const createMachine = <State, View, Requirements, Result, Children extends ComponentChildren, Dependencies extends ComponentDependencies, Interactions>(
  definition: ComponentDefinition<State, View, Requirements, Result, Children, Dependencies, Interactions>,
  members: ReadonlyArray<Component<unknown, unknown>>,
  identities: ReadonlyArray<string>
): ComponentMachine<View, Requirements | ComponentDataRequirements<Dependencies>, Result, Interactions> => {
  const identity = definition.name
  const bind = (snapshots: ReadonlyArray<unknown>, event?: Event): ChildOf<Children> => {
    const handles = members.map((member, index) => bindChild(machineOf(member), snapshots[index], event === undefined ? 0 : eventPositionOf(event) ?? 0, Number(event?.at ?? 0)))
    return (definition.children !== undefined && !Array.isArray(definition.children) ? handles[0] : Object.freeze(handles)) as ChildOf<Children>
  }
  type Snapshot = { readonly own: State; readonly children: ReadonlyArray<unknown>; readonly handles: ChildOf<Children> }
  const projection = materializeProjection<Snapshot, ComponentOutput<View, Requirements, Result, Interactions>>({
    initial: (data = Context.empty()) => {
      const children = members.map((member) => machineOf(member).initial(data))
      const handles = bind(children)
      return { own: definition.initial(handles, (definition.dependencies ?? []).map(key => Context.getUnsafe(data, key)) as ComponentData<Dependencies>), children, handles }
    },
    step: (state, event) => {
      const children = members.map((member, index) => machineOf(member).step(state.children[index], event))
      const unchanged = children.every((child, index) => Object.is(child, state.children[index]))
      const handles = unchanged ? state.handles : bind(children, event)
      const own = definition.step(state.own, event, bindTransitionContext(event, identity), handles, state.handles)
      return Object.is(own, state.own) && unchanged ? state : { own, children, handles }
    },
    output: (state) => {
      const output = definition.output(state.own, state.handles)
      validateTransitions(output.transitions, identities)
      const cancel = output.interactions?.cancel
      return cancel === undefined ? output : {
        ...output,
        interactions: { ...output.interactions!, cancel: (cancellation: Parameters<typeof cancel>[0]) => validateTransitions(cancel(cancellation), identities) }
      }
    }
  })
  type CachedState = MaterializedProjectionState<Snapshot, ComponentOutput<View, Requirements, Result, Interactions>>
  return {
    initial: projection.initial,
    step: (state, event) => projection.step(state as CachedState, event),
    output: (state) => projection.output(state as CachedState)
  }
}
