import { Context, Schema } from "effect"
import { AtomRegistry } from "effect/reactivity"
import type { Atom, PrimitiveAtom, SetStateAction } from "./atom"
import { EventLog, eventLogContext } from "../services/event-log"
import { actorGraph } from "./graph"
import { atomInput, atomValidator } from "./effect"

// createStore owns an Effect registry and provides services to durable projections.
export function createStore(services?: Context.Context<EventLog>) {
  const registry = AtomRegistry.make()
  if (services) registry.set(eventLogContext, services)
  const reachable = (roots: Readonly<Record<string, Atom<unknown>>>) => {
    for (const root of Object.values(roots)) registry.get(root)
    const nodes = registry.getNodes()
    const visited = new Set<AtomRegistry.Node<unknown>>()
    const visit = (node: AtomRegistry.Node<unknown>) => {
      if (visited.has(node)) return
      visited.add(node)
      for (const parent of node.parents) visit(parent)
    }
    for (const root of Object.values(roots)) {
      const node = nodes.get(root)
      if (node) visit(node)
    }
    return visited
  }
  return {
    get: <Value>(node: Atom<Value>): Value => registry.get(node),
    graph: (roots: Readonly<Record<string, Atom<unknown>>>) => actorGraph(registry, roots),
    nodes: () => registry.getNodes(),
    eventSchemas: (roots: Readonly<Record<string, Atom<unknown>>>) => {
      const schemas = new Set<Schema.Top>()
      for (const { atom } of reachable(roots)) {
        const input = atomInput(atom) ?? ("input" in atom && Schema.isSchema(atom.input) ? atom.input : undefined)
        if (input) schemas.add(input)
      }
      return schemas
    },
    validate: (roots: Readonly<Record<string, Atom<unknown>>>, event: object) => {
      const validators = new Set<NonNullable<ReturnType<typeof atomValidator>>>()
      for (const node of reachable(roots)) {
        const validate = atomValidator(node.atom)
        if (validate) validators.add(validate)
      }
      for (const validate of validators) validate(event, node => registry.get(node))
    },
    set: <Value>(node: PrimitiveAtom<Value>, value: SetStateAction<Value>) => registry.set(node, value),
    sub: <Value>(node: Atom<Value>, listener: () => void) => {
      registry.get(node)
      return registry.subscribe(node, () => listener())
    },
    dispose: () => registry.dispose(),
  }
}
