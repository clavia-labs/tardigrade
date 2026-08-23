import { actorFromReactors, type Actor, type Reactor, type Transition } from "./actor"
import type { Event } from "./event"
import { composeKeys, type KeyFragment } from "./event-log"

// Derivation is one component's reading of a log: a view for consumers and transitions for the
// actor runtime. The view follows tla/runtime/Projection.tla, ViewFaithful. The
// transitions follow tla/runtime/Reconcile.tla, NoVoid.
export interface Derivation<V, R = never> {
  readonly view: V
  readonly transitions: ReadonlyArray<Transition<never, R>>
}

// Component derives a view and owed work from the same log. Its key fragment declares how
// the events its transitions append prove commitment to the actor runtime.
export interface Component<V, R = never> {
  readonly name: string
  readonly keys?: KeyFragment
  readonly derive: (log: ReadonlyArray<Event>) => Derivation<V, R>
}

// ViewAlgebra states how independently derived views compose. Callers supply the empty value and
// combination rule because ordering, collisions, and overrides belong to the view's consumer.
export interface ViewAlgebra<V> {
  readonly empty: V
  readonly combine: (left: V, right: V) => V
}

// ComponentRequirements extracts a component's environment so composition carries the union of every
// member's requirements to the actor that hosts it.
export type ComponentRequirements<C> = C extends Component<unknown, infer R> ? R : never

// composeComponents derives the algebraic sum of each component's view and concatenates
// its transitions in component order. The name is explicit because traces and collision errors
// identify the resulting component with it.
export const composeComponents = <
  V,
  const Cs extends ReadonlyArray<Component<V, never> | Component<V, unknown>>
>(
  name: string,
  algebra: ViewAlgebra<V>,
  components: Cs
): Component<V, ComponentRequirements<Cs[number]>> => {
  const members = components as ReadonlyArray<Component<V, ComponentRequirements<Cs[number]>>>
  const fragments = members.flatMap((component) => component.keys === undefined ? [] : [component.keys])
  const keys = fragments.length === 0
    ? undefined
    : {
        prefixes: fragments.flatMap((fragment) => fragment.prefixes),
        keyOf: composeKeys(...fragments)
      }
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
      return { view, transitions }
    }
  }
}

// reactorOf exposes a component's owed-work projection to the existing actor reconciler.
export const reactorOf = <V, R>(component: Component<V, R>): Reactor<R> =>
  (log) => component.derive(log).transitions

// actor composes root components at the execution boundary. Composite components own their
// view algebra; the actor preserves root order, adapts each transition projection to a reactor,
// and combines every committing key fragment for reconciliation.
export const actor = <
  const Cs extends ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>
>(...components: Cs): Actor<ComponentRequirements<Cs[number]>> => {
  type R = ComponentRequirements<Cs[number]>
  const members = components as ReadonlyArray<Component<unknown, R>>
  const keys = members.flatMap((component) => component.keys === undefined ? [] : [component.keys])
  return actorFromReactors(members.map(reactorOf), composeKeys(...keys))
}
