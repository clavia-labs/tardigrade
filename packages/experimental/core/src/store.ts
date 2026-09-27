import { Context } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import type { Atom, PrimitiveAtom, SetStateAction } from "./atom"
import { EventLog, eventLogContext } from "./durable"
import { actorGraph } from "./graph"

// createStore owns an Effect registry and provides services to durable projections.
export function createStore(services?: Context.Context<EventLog>) {
  const registry = AtomRegistry.make()
  if (services) registry.set(eventLogContext, services)
  return {
    get: <Value>(node: Atom<Value>): Value => registry.get(node),
    graph: (roots: Readonly<Record<string, Atom<unknown>>>) => actorGraph(registry, roots),
    set: <Value>(node: PrimitiveAtom<Value>, value: SetStateAction<Value>) => registry.set(node, value),
    sub: <Value>(node: Atom<Value>, listener: () => void) => {
      registry.get(node)
      return registry.subscribe(node, () => listener())
    },
    dispose: () => registry.dispose(),
  }
}
