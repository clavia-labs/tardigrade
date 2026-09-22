import { machineOf, registerComponent } from "../runtime"
import { TRANSITION_COMPONENT_IDS, transitionComponentIds, validateTransitions } from "../../transition/transition"
import { Chunk } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { materializeProjection, type MaterializedProjectionState } from "@clavia/tardigrade-core/projection"
import type { ViewAlgebra } from "@clavia/tardigrade-core/view"
import { composeKeys } from "../../log/keys"
import {
  type Component,
  type ComponentRequirements,
  type ComponentInteractions,
  type ComponentResult
} from "../component"
import {
  type ComponentMachine,
  type InvocationCancellation
} from "../machine"
import { reconcileComponentOutput, type TransitionReconciler } from "./reconciliation"
import {
  buildOutputTree,
  replaceOutputTree,
  type OutputTree
} from "./tree"
import { COMPONENT_CONTRACT, mergeComponentContracts } from "../../actor/contract"
import type { ComponentOutput } from "../output"

export type { ViewAlgebra } from "@clavia/tardigrade-core/view"
export type { TransitionReconciler } from "./reconciliation"
export { independentTransitions } from "./reconciliation"

// CompositionOptions selects proposed work using the explicitly combined public view.
export type CompositionOptions<R = never, View = unknown, Inputs = ReadonlyArray<unknown>, Interactions = unknown> = {
  readonly reconcile?: TransitionReconciler<R, View>
  readonly interactions?: (children: Inputs) => Interactions
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
 *     ├── project interactions when declared
 *     ├── concatenate child transitions
 *     └── reconcile enabled work
 *     ↓
 *   ComponentOutput
 *     ├── projected interactions
 *     ├── combined view
 *     └── selected transitions
 *
 * Plain composition with a lawful view algebra preserves output under regrouping (component/composition/laws.properties.test.ts, "every grouping agrees with the flat composition"). Boundary policies and interaction projections define their own grouping behavior (component/composition/view.test.ts). Stable child identity reuses cached branches (component/composition/siblings.test.ts, "composition reuses branches whose child state identities are stable").
 */
export function composeComponents<
  View,
  const Components extends ReadonlyArray<Component<View, never> | Component<View, unknown>>,
  Interactions = unknown
>(
  name: string,
  algebra: ViewAlgebra<View>,
  components: Components,
  options: CompositionOptions<ComponentRequirements<Components[number]>, View, { readonly [K in keyof Components]: ComponentInteractions<Components[K]> | undefined }, Interactions> = {}
): Component<View, ComponentRequirements<Components[number]>, ComponentResult<Components[number]>, Interactions> {
  type Result = ComponentResult<Components[number]>
  type Requirements = ComponentRequirements<Components[number]>
  type Machine = ComponentMachine<View, Requirements, Result>
  type ChildState = MaterializedProjectionState<unknown, ReturnType<Machine["output"]>>
  type Output = ReturnType<Machine["output"]>
  type PublicOutput = ComponentOutput<View, Requirements, Result, Interactions>
  interface CompositionState {
    readonly children: ReadonlyArray<ChildState>
    readonly root: OutputTree<Output>
    // TODO: Give reconciliation its own projection state so composition does not retain the complete event history.
    readonly history: Chunk.Chunk<Event>
    readonly output: PublicOutput
  }

  const members = components as unknown as ReadonlyArray<Component<View, Requirements, Result>>
  if (typeof name !== "string" || name.length === 0) throw new Error("components require a nonempty name")
  const componentIds = transitionComponentIds([{ [TRANSITION_COMPONENT_IDS]: [name] }, ...members])
  const fragments = members.flatMap((component) => component.keys === undefined ? [] : [component.keys])
  const keys = fragments.length === 0
    ? undefined
    : {
        prefixes: fragments.flatMap((fragment) => fragment.prefixes),
        keyOf: composeKeys(...fragments)
      }
  const machines = members.map((component) => machineOf(component))
  const materialized = machines.map(materializeProjection)
  const reconcile = options.reconcile

  const outputFrom = (output: Output, history: Chunk.Chunk<Event>, children: ReadonlyArray<ChildState>): PublicOutput => {
    const interactions = options.interactions?.(children.map(child => child.value.interactions) as { readonly [K in keyof Components]: ComponentInteractions<Components[K]> | undefined })
    const cleanup = children.flatMap(child => child.value.interactions?.cancel ?? [])
    const combined = (cleanup.length === 0 ? interactions : {
      ...interactions,
      cancel: (cancellation: InvocationCancellation) => cleanup.flatMap(cancel => cancel(cancellation))
    }) as PublicOutput["interactions"]
    return reconcileComponentOutput(name, reconcile, Chunk.toReadonlyArray(history), { view: output.view, transitions: output.transitions, ...(combined === undefined ? {} : { interactions: combined }) })
  }

  const combine = (left: Output, right: Output): Output => ({
    view: algebra.combine(left.view, right.view),
    transitions: [...left.transitions, ...right.transitions]
  })

  const projection = materializeProjection<CompositionState, PublicOutput>({
    initial: (data) => {
      const children = materialized.map((machine) => machine.initial(data))
      const root = buildOutputTree(children.map((child) => child.value), { view: algebra.empty, transitions: [] }, combine)
      const history = Chunk.empty<Event>()
      return {
        children,
        root,
        history,
        output: outputFrom(root.output, history, children)
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
        output: outputFrom(root.output, history, children ?? state.children)
      }
    },
    output: (state) => {
      validateTransitions(state.output.transitions)
      return state.output
    }
  })
  type CachedState = MaterializedProjectionState<CompositionState, PublicOutput>
  return registerComponent({
    name,
    [TRANSITION_COMPONENT_IDS]: componentIds,
    [COMPONENT_CONTRACT]: mergeComponentContracts(members),
    ...(keys === undefined ? {} : { keys }),

  }, {
    initial: projection.initial,
    step: (state, event) => projection.step(state as CachedState, event),
    output: (state) => projection.output(state as CachedState)
  })
}
