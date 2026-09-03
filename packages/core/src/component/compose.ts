import { Chunk } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { materializeProjection, type MaterializedProjectionState } from "@clavia/tardigrade-core/projection"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { ViewAlgebra } from "@clavia/tardigrade-core/view"
import { composeKeys } from "../log/keys"
import {
  type Component,
  type ComponentRequirements
} from "./component"
import {
  component,
  type ComponentMachine,
  type InvocationCancellation
} from "./machine"
import {
  reconcileComponentOutput,
  type TransitionReconciler
} from "./reconciliation"
import {
  buildOutputTree,
  replaceOutputTree,
  type OutputTree
} from "./tree"
import { COMPONENT_CONTRACT, mergeComponentContracts } from "../actor/contract"

export type { ViewAlgebra } from "@clavia/tardigrade-core/view"
export type { TransitionReconciler } from "./reconciliation"
export { independentTransitions } from "./reconciliation"

// CompositionOptions sets the reconciliation policy at this component boundary.
export interface CompositionOptions<R = never> {
  readonly reconcile?: TransitionReconciler<R>
}

/**
 * composeComponents constructs one product machine from a component tree.
 *
 *   Event
 *     ↓
 *   Composed ComponentMachine
 *     ├── step every child machine once
 *     ├── retain unchanged child identities
 *     ├── update changed output-tree branches
 *     ├── combine child views
 *     ├── concatenate child transitions
 *     └── reconcile enabled work
 *     ↓
 *   ComponentOutput
 *     ├── combined view
 *     └── selected transitions
 *
 * Composition is the synchronous product of its children, and regrouping preserves observable output (component/compose.properties.test.ts, "the composed machine is the synchronous product of its children" and "every grouping agrees with the flat composition"). Stable child identity reuses cached branches (component/compose.test.ts, "composition reuses branches whose child state identities are stable").
 */
export const composeComponents = <
  View,
  const Components extends ReadonlyArray<Component<View, never> | Component<View, unknown>>
>(
  name: string,
  algebra: ViewAlgebra<View>,
  components: Components,
  options: CompositionOptions<ComponentRequirements<Components[number]>> = {}
): Component<View, ComponentRequirements<Components[number]>> => {
  type Requirements = ComponentRequirements<Components[number]>
  type Machine = ComponentMachine<View, Requirements>
  type ChildState = MaterializedProjectionState<unknown, ReturnType<Machine["output"]>>
  type Output = ReturnType<Machine["output"]>
  interface CompositionState {
    readonly children: ReadonlyArray<ChildState>
    readonly root: OutputTree<Output>
    // TODO: Give reconciliation its own projection state so composition does not retain the complete event history.
    readonly history: Chunk.Chunk<Event>
    readonly output: Output
  }

  const members = components as ReadonlyArray<Component<View, Requirements>>
  const fragments = members.flatMap((component) => component.keys === undefined ? [] : [component.keys])
  const keys = fragments.length === 0
    ? undefined
    : {
        prefixes: fragments.flatMap((fragment) => fragment.prefixes),
        keyOf: composeKeys(...fragments)
      }
  const machines = members.map((component) => component.machine)
  const materialized = machines.map(materializeProjection)
  const reconcile = options.reconcile

  const combine = (left: Output, right: Output): Output => ({
    view: algebra.combine(left.view, right.view),
    transitions: [...left.transitions, ...right.transitions]
  })

  const cancel = (
    state: CompositionState,
    node: OutputTree<Output>,
    cancellation: InvocationCancellation
  ): ReadonlyArray<Transition<never, Requirements>> => {
    if (node.kind === "empty") return []
    if (node.kind === "leaf") {
      return machines[node.index]!.cancel?.(state.children[node.index]!.state, cancellation) ?? []
    }
    return [...cancel(state, node.left, cancellation), ...cancel(state, node.right, cancellation)]
  }

  return component<CompositionState, View, Requirements>({
    name,
    ...(keys === undefined ? {} : { keys }),
    [COMPONENT_CONTRACT]: mergeComponentContracts(members),
    initial: () => {
      const children = materialized.map((machine) => machine.initial())
      const root = buildOutputTree(children.map((child) => child.value), { view: algebra.empty, transitions: [] }, combine)
      const history = Chunk.empty<Event>()
      return {
        children,
        root,
        history,
        output: reconcileComponentOutput(name, reconcile, Chunk.toReadonlyArray(history), root.output)
      }
    },
    step: (state, event) => {
      let children: Array<ChildState> | undefined
      const changed: Array<number> = []
      for (let index = 0; index < materialized.length; index++) {
        const current = state.children[index]!
        const child = materialized[index]!.step(current, event)
        if (Object.is(child, current)) continue
        children ??= [...state.children]
        children[index] = child
        changed.push(index)
      }
      if (children === undefined && reconcile === undefined) return state
      let root = state.root
      if (children !== undefined) {
        const replacementCost = changed.length * Math.max(1, Math.ceil(Math.log2(children.length)))
        if (replacementCost >= children.length) {
          root = buildOutputTree(children.map((child) => child.value), { view: algebra.empty, transitions: [] }, combine)
        } else {
          for (const index of changed) root = replaceOutputTree(root, index, children[index]!.value, combine)
        }
      }
      const history = reconcile === undefined ? state.history : Chunk.append(state.history, event)
      return {
        children: children ?? state.children,
        root,
        history,
        output: reconcileComponentOutput(name, reconcile, Chunk.toReadonlyArray(history), root.output)
      }
    },
    output: (state) => state.output,
    cancelState: (state: CompositionState, cancellation: InvocationCancellation) => cancel(state, state.root, cancellation)
  })
}
