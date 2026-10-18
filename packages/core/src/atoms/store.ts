import { Context, Schema } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import type { Atom, PrimitiveAtom, SetStateAction } from "./atom"
import { EventLog, eventLogContext } from "../services/event-log"
import { actorGraph } from "./graph"
import { atomInput, atomValidator } from "./effect"
import { memoryDocuments } from "../services/tree-state"

// createStore supplies private in-memory documents when EventLog omits storage (properties/collections.test.ts).
export function createStore(services?: Context.Context<EventLog>) {
  const registry = AtomRegistry.make()
  let documents: ReturnType<typeof memoryDocuments> | undefined
  let localLog: typeof EventLog.Service | undefined
  const withDocuments = (context: Context.Context<EventLog> | undefined) => {
    const service = context && Context.get(context, EventLog)
    if (service && service === localLog) return context
    if (localLog) documents!.release(localLog)
    localLog = undefined
    if (!context || !service) return context
    if (service.documents) {
      if (service.documents === documents) localLog = service
      return context
    }
    documents ??= memoryDocuments()
    localLog = { ...service, documents }
    return Context.add(context, EventLog, localLog)
  }
  if (services) registry.set(eventLogContext, withDocuments(services))
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
    set: <Value>(node: PrimitiveAtom<Value>, value: SetStateAction<Value>) => {
      if (Object.is(node, eventLogContext)) {
        const context = typeof value === "function" ? (value as (previous: Value) => Value)(registry.get(node)) : value
        registry.set(eventLogContext, withDocuments(context as Context.Context<EventLog> | undefined))
      } else registry.set(node, value)
    },
    sub: <Value>(node: Atom<Value>, listener: () => void) => {
      registry.get(node)
      return registry.subscribe(node, () => listener())
    },
    dispose: () => {
      registry.dispose()
      if (localLog) documents!.release(localLog)
      localLog = undefined
      documents?.discard()
      documents?.clear()
    },
  }
}
