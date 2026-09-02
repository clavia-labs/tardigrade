import { Chunk } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { materializeProjection, type MaterializedProjectionState } from "@clavia/tardigrade-core/projection"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { ViewAlgebra } from "@clavia/tardigrade-core/view"
import { composeKeys } from "../log/keys"
import {
  incrementalComponent,
  type Component,
  type ComponentMachine,
  type ComponentRequirements,
  type InvocationCancellation
} from "./component"
import { COMPONENT_CONTRACT, mergeComponentContracts } from "../actor/contract"

export type { ViewAlgebra } from "@clavia/tardigrade-core/view"

// TransitionReconciler selects work from the complete child transition set before external effects begin. It returns only transitions it received, each at most once (component.test.ts, "composition refuses work a reconciler did not receive" and "composition refuses a transition selected more than once").
export type TransitionReconciler<R = never> = (
  log: ReadonlyArray<Event>,
  transitions: ReadonlyArray<Transition<never, R>>
) => ReadonlyArray<Transition<never, R>>

// independentTransitions preserves every transition in child order.
export const independentTransitions = <R>(
  _log: ReadonlyArray<Event>,
  transitions: ReadonlyArray<Transition<never, R>>
): ReadonlyArray<Transition<never, R>> => transitions

// CompositionOptions sets the reconciliation policy at this component boundary.
export interface CompositionOptions<R = never> {
  readonly reconcile?: TransitionReconciler<R>
}

// composeComponents combines child views and reconciles their complete transition set.
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
  type CompositionNode =
    | { readonly kind: "empty"; readonly end: 0; readonly output: Output }
    | { readonly kind: "leaf"; readonly index: number; readonly end: number; readonly output: Output }
    | {
        readonly kind: "branch"
        readonly end: number
        readonly left: CompositionNode
        readonly right: CompositionNode
        readonly output: Output
      }
  interface CompositionState {
    readonly children: ReadonlyArray<ChildState>
    readonly root: CompositionNode
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

  const branch = (left: CompositionNode, right: CompositionNode): CompositionNode => ({
    kind: "branch",
    end: right.end,
    left,
    right,
    output: combine(left.output, right.output)
  })

  const build = (children: ReadonlyArray<ChildState>, start: number, end: number): CompositionNode => {
    if (start === end) return { kind: "empty", end: 0, output: { view: algebra.empty, transitions: [] } }
    if (end - start === 1) {
      return { kind: "leaf", index: start, end, output: children[start]!.value }
    }
    const middle = start + Math.floor((end - start) / 2)
    return branch(build(children, start, middle), build(children, middle, end))
  }

  const replace = (node: CompositionNode, index: number, output: Output): CompositionNode => {
    if (node.kind === "leaf") return { kind: "leaf", index, end: node.end, output }
    if (node.kind === "empty") return node
    return index < node.left.end
      ? branch(replace(node.left, index, output), node.right)
      : branch(node.left, replace(node.right, index, output))
  }

  const reconcileOutput = (
    output: Output,
    history: Chunk.Chunk<Event>
  ): Output => {
    const transitions = output.transitions
    if (reconcile === undefined || transitions.length === 0) return output
    const resolved = reconcile(Chunk.toReadonlyArray(history), transitions)
    const received = new Set(transitions)
    const seen = new Set<Transition<never, Requirements>>()
    for (const selected of resolved) {
      if (!received.has(selected)) {
        throw new Error(`component "${name}" reconciler returned work outside its transition set`)
      }
      if (seen.has(selected)) {
        throw new Error(`component "${name}" reconciler returned transition "${selected.key}" more than once`)
      }
      seen.add(selected)
    }
    return { view: output.view, transitions: resolved }
  }

  const cancel = (
    state: CompositionState,
    node: CompositionNode,
    cancellation: InvocationCancellation
  ): ReadonlyArray<Transition<never, Requirements>> => {
    if (node.kind === "empty") return []
    if (node.kind === "leaf") {
      return machines[node.index]!.cancel?.(state.children[node.index]!.state, cancellation) ?? []
    }
    return [...cancel(state, node.left, cancellation), ...cancel(state, node.right, cancellation)]
  }

  return incrementalComponent<CompositionState, View, Requirements>({
    name,
    ...(keys === undefined ? {} : { keys }),
    [COMPONENT_CONTRACT]: mergeComponentContracts(members),
    initial: () => {
      const children = materialized.map((machine) => machine.initial())
      const root = build(children, 0, children.length)
      const history = Chunk.empty<Event>()
      return { children, root, history, output: reconcileOutput(root.output, history) }
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
          root = build(children, 0, children.length)
        } else {
          for (const index of changed) root = replace(root, index, children[index]!.value)
        }
      }
      const history = reconcile === undefined ? state.history : Chunk.append(state.history, event)
      return {
        children: children ?? state.children,
        root,
        history,
        output: reconcileOutput(root.output, history)
      }
    },
    output: (state) => state.output,
    cancelState: (state: CompositionState, cancellation: InvocationCancellation) => cancel(state, state.root, cancellation)
  })
}
