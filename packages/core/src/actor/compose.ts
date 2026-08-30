import type { Event } from "../log/event"
import { composeKeys } from "../log/keys"
import type { Transition } from "../reconciliation"
import type { Component, ComponentRequirements, InvocationCancellation } from "./component"
import { COMPONENT_CONTRACT, mergeComponentContracts } from "./contract"

// ViewAlgebra defines the empty view and how two independently derived views combine.
export interface ViewAlgebra<V> {
  readonly empty: V
  readonly combine: (left: V, right: V) => V
}

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
  V,
  const Cs extends ReadonlyArray<Component<V, never> | Component<V, unknown>>
>(
  name: string,
  algebra: ViewAlgebra<V>,
  components: Cs,
  options: CompositionOptions<ComponentRequirements<Cs[number]>> = {}
): Component<V, ComponentRequirements<Cs[number]>> => {
  const members = components as ReadonlyArray<Component<V, ComponentRequirements<Cs[number]>>>
  const fragments = members.flatMap((component) => component.keys === undefined ? [] : [component.keys])
  const keys = fragments.length === 0
    ? undefined
    : {
        prefixes: fragments.flatMap((fragment) => fragment.prefixes),
        keyOf: composeKeys(...fragments)
      }
  const reconcile = options.reconcile ?? independentTransitions
  return {
    name,
    ...(keys === undefined ? {} : { keys }),
    [COMPONENT_CONTRACT]: mergeComponentContracts(members),
    cancel: (log, cancellation: InvocationCancellation) =>
      members.flatMap((component) => component.cancel?.(log, cancellation) ?? []),
    derive: (log) => {
      let view = algebra.empty
      const transitions: Array<Transition<never, ComponentRequirements<Cs[number]>>> = []
      for (const component of members) {
        const derived = component.derive(log)
        view = algebra.combine(view, derived.view)
        transitions.push(...derived.transitions)
      }
      const resolved = reconcile(log, transitions)
      const received = new Set(transitions)
      const seen = new Set<Transition<never, ComponentRequirements<Cs[number]>>>()
      for (const selected of resolved) {
        if (!received.has(selected)) {
          throw new Error(`component "${name}" reconciler returned work outside its transition set`)
        }
        if (seen.has(selected)) {
          throw new Error(`component "${name}" reconciler returned transition "${selected.key}" more than once`)
        }
        seen.add(selected)
      }
      return { view, transitions: resolved }
    }
  }
}
