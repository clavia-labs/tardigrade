import { actor, type Actor, type Reactor, type Transition } from "./actor"
import type { Event } from "./event"
import { composeKeys, type KeyFragment } from "./event-log"

// Derivation is one component's reading of a log: information for consumers and transitions
// for the actor runtime. The information follows tla/Projection.tla, ViewFaithful. The
// transitions follow tla/Reconcile.tla, NoVoid.
export interface Derivation<I, R = never> {
  readonly info: I
  readonly transitions: ReadonlyArray<Transition<never, R>>
}

// Component derives information and owed work from the same log. Its key fragment declares how
// the events its transitions append prove commitment to the actor runtime.
export interface Component<I, R = never> {
  readonly name: string
  readonly keys?: KeyFragment
  readonly derive: (log: ReadonlyArray<Event>) => Derivation<I, R>
}

// InfoAlgebra states how independently derived information composes. Callers supply the empty
// value and combination rule because ordering, collisions, and overrides belong to the
// information's consumer.
export interface InfoAlgebra<I> {
  readonly empty: I
  readonly combine: (left: I, right: I) => I
}

// ComponentRuntime interprets composed information as reactors and supplies the key fragments
// for its protocol. The reactor factory is polymorphic in component requirements because an
// interpreter may route work whose environment is declared by the component that contributed it.
export interface ComponentRuntime<I, R = never> {
  readonly name: string
  readonly algebra: InfoAlgebra<I>
  readonly keys: ReadonlyArray<KeyFragment>
  readonly reactors: <C>(infoOf: (log: ReadonlyArray<Event>) => I) => ReadonlyArray<Reactor<R | C>>
}

// ComponentRequirements extracts a component's environment so composition carries the union of every
// member's requirements to the actor that hosts it.
export type ComponentRequirements<C> = C extends Component<unknown, infer R> ? R : never

// composeComponents derives the algebraic sum of each component's information and concatenates
// its transitions in component order. The name is explicit because traces and collision errors
// identify the resulting component with it.
export const composeComponents = <
  I,
  const Cs extends ReadonlyArray<Component<I, never> | Component<I, unknown>>
>(
  name: string,
  algebra: InfoAlgebra<I>,
  components: Cs
): Component<I, ComponentRequirements<Cs[number]>> => {
  const members = components as ReadonlyArray<Component<I, ComponentRequirements<Cs[number]>>>
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
      let info = algebra.empty
      const transitions: Array<Transition<never, ComponentRequirements<Cs[number]>>> = []
      for (const component of members) {
        const derived = component.derive(log)
        info = algebra.combine(info, derived.info)
        transitions.push(...derived.transitions)
      }
      return { info, transitions }
    }
  }
}

// reactorOf exposes a component's owed-work projection to the existing actor reconciler.
export const reactorOf = <I, R>(component: Component<I, R>): Reactor<R> =>
  (log) => component.derive(log).transitions

// actorOf composes components under one information runtime and adapts their transitions to the
// existing actor reconciler. Runtime keys compose beside component keys with the same collision
// rule as composeKeys.
export const actorOf = <
  I,
  RuntimeR,
  const Cs extends ReadonlyArray<Component<I, never> | Component<I, unknown>>
>(
  runtime: ComponentRuntime<I, RuntimeR>,
  components: Cs
): Actor<RuntimeR | ComponentRequirements<Cs[number]>> => {
  type ComponentR = ComponentRequirements<Cs[number]>
  type R = RuntimeR | ComponentR
  const combined = composeComponents(runtime.name, runtime.algebra, components) as Component<I, R>
  const infoOf = (log: ReadonlyArray<Event>): I => combined.derive(log).info
  const reactors = runtime.reactors<ComponentR>(infoOf) as ReadonlyArray<Reactor<R>>
  return actor(
    [...reactors, reactorOf(combined)],
    composeKeys(...runtime.keys, ...(combined.keys === undefined ? [] : [combined.keys]))
  )
}
