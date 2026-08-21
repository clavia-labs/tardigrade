import { actor, type Actor, type Reactor, type Transition } from "./actor"
import type { Event } from "./event"
import { composeKeys, type KeyFragment } from "./event-log"

// Derivation is one component's reading of a log: a view for consumers and transitions for the
// actor runtime. The view follows tla/Projection.tla, ViewFaithful. The
// transitions follow tla/Reconcile.tla, NoVoid.
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

// ComponentRuntime interprets a composed view as reactors and supplies the key fragments
// for its protocol. The reactor factory is polymorphic in component requirements because an
// interpreter may route work whose environment is declared by the component that contributed it.
export interface ComponentRuntime<V, R = never> {
  readonly name: string
  readonly algebra: ViewAlgebra<V>
  readonly keys: ReadonlyArray<KeyFragment>
  readonly reactors: <C>(viewOf: (log: ReadonlyArray<Event>) => V) => ReadonlyArray<Reactor<R | C>>
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

// actorOf composes components under one view runtime and adapts their transitions to the
// existing actor reconciler. Runtime keys compose beside component keys with the same collision
// rule as composeKeys.
export const actorOf = <
  V,
  RuntimeR,
  const Cs extends ReadonlyArray<Component<V, never> | Component<V, unknown>>
>(
  runtime: ComponentRuntime<V, RuntimeR>,
  components: Cs
): Actor<RuntimeR | ComponentRequirements<Cs[number]>> => {
  type ComponentR = ComponentRequirements<Cs[number]>
  type R = RuntimeR | ComponentR
  const combined = composeComponents(runtime.name, runtime.algebra, components) as Component<V, R>
  const viewOf = (log: ReadonlyArray<Event>): V => combined.derive(log).view
  const reactors = runtime.reactors<ComponentR>(viewOf) as ReadonlyArray<Reactor<R>>
  return actor(
    [...reactors, reactorOf(combined)],
    composeKeys(...runtime.keys, ...(combined.keys === undefined ? [] : [combined.keys]))
  )
}
