import { actorFromReactors, type Actor, type Reactor, type Transition } from "./actor"
import type { Event } from "./event"
import { composeKeys, type KeyFragment } from "./event-log"

// Derivation contains one component's view and transition projections
// (tla/runtime/Projection.tla, ViewFaithful; tla/runtime/Reconcile.tla, NoVoid).
export interface Derivation<V, R = never> {
  readonly view: V
  readonly transitions: ReadonlyArray<Transition<never, R>>
}

// Component derives a view and transitions from one log and declares their committing keys.
export interface Component<V, R = never> {
  readonly name: string
  readonly keys?: KeyFragment
  readonly derive: (log: ReadonlyArray<Event>) => Derivation<V, R>
}

// ViewAlgebra defines the empty view and how two independently derived views combine.
export interface ViewAlgebra<V> {
  readonly empty: V
  readonly combine: (left: V, right: V) => V
}

// TransitionReconciler selects work from the complete child transition set before external effects
// begin (tla/runtime/Coherence.tla, NoSuppressedCommit). It returns only transitions it received,
// each at most once (component.test.ts, "composition refuses work a reconciler did not receive" and
// "composition refuses a transition selected more than once").
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

// ComponentRequirements extracts a component's service requirements.
export type ComponentRequirements<C> = C extends Component<unknown, infer R> ? R : never

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

// reactorOf exposes a component's transition projection as a reactor.
export const reactorOf = <V, R>(component: Component<V, R>): Reactor<R> =>
  (log) => component.derive(log).transitions

// actor adapts root components to reactors and combines their committing key fragments.
export const actor = <
  const Cs extends ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>
>(...components: Cs): Actor<ComponentRequirements<Cs[number]>> => {
  type R = ComponentRequirements<Cs[number]>
  const members = components as ReadonlyArray<Component<unknown, R>>
  const keys = members.flatMap((component) => component.keys === undefined ? [] : [component.keys])
  return actorFromReactors(members.map(reactorOf), composeKeys(...keys))
}
