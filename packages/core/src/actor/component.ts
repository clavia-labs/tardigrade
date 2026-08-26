import type { Event } from "../log/event"
import type { KeyFragment } from "../log/keys"
import type { Reactor, Transition } from "../reconciliation"
import type { COMPONENT_CONTRACT, ComponentContract } from "./contract"

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
  readonly [COMPONENT_CONTRACT]?: ComponentContract
  readonly derive: (log: ReadonlyArray<Event>) => Derivation<V, R>
}

// ComponentRequirements extracts a component's service requirements.
export type ComponentRequirements<C> = C extends Component<unknown, infer R> ? R : never

// reactorOf exposes a component's transition projection as a reactor.
export const reactorOf = <V, R>(component: Component<V, R>): Reactor<R> =>
  (log) => component.derive(log).transitions
