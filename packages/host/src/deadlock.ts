import * as Graph from "effect/Graph"
import type { Event } from "@clavia/tardigrade-core/event"

// Deadlock detection over the waits-for graph. Lanes are nodes; an
// unanswered awaiting call is an edge to the lane whose settle answers
// it. A cycle is a deadlock: every member lane rests honestly, blocked
// on the world, and the world is the other members. No lane-local
// invariant can see a cycle (packages/core/tla/Delivery.tla, the
// DeliveryDeadlock config is the pinned trace); only the tier that
// sees all lanes can break one.
//
// effect/Graph (experimental) stays inside this file. No Graph type
// crosses the exported surface, so the engine can change without any
// consumer noticing.

// AwaitEdge is one taut edge in the waits-for graph: who waits, on
// whom, and the reply id that discharges the wait. The edge carries
// the caller's knowledge of lane naming; the host stays generic.
export interface AwaitEdge {
  readonly from: string
  readonly to: string
  readonly replyId: string
  readonly callId: string
}

// EdgesOf derives one lane's awaiting edges from its events. It must
// be a pure projection: the sentinel re-derives after every drain.
export type EdgesOf = (lane: string, events: ReadonlyArray<Event>) => ReadonlyArray<AwaitEdge>

// Deadlock is one await cycle: its member lanes and the taut edges
// among them.
export interface Deadlock {
  readonly members: ReadonlyArray<string>
  readonly edges: ReadonlyArray<AwaitEdge>
}

// deadlocks returns every await cycle among the lanes, each with its
// member lanes and the taut edges inside it.
export const deadlocks = (
  lanes: ReadonlyMap<string, ReadonlyArray<Event>>,
  edgesOf: EdgesOf
): ReadonlyArray<Deadlock> => {
  const taut: AwaitEdge[] = []
  for (const [lane, events] of lanes) {
    for (const edge of edgesOf(lane, events)) {
      if (lanes.has(edge.to)) taut.push(edge)
    }
  }
  if (taut.length === 0) return []

  const index = new Map<string, Graph.NodeIndex>()
  const g = Graph.mutate(Graph.directed<string, AwaitEdge>(), (m) => {
    for (const lane of lanes.keys()) index.set(lane, Graph.addNode(m, lane))
    for (const edge of taut) {
      Graph.addEdge(m, index.get(edge.from)!, index.get(edge.to)!, edge)
    }
  })
  if (Graph.isAcyclic(g)) return []

  const nameOf = new Map<Graph.NodeIndex, string>()
  for (const [lane, i] of index) nameOf.set(i, lane)
  const out: Deadlock[] = []
  for (const component of Graph.stronglyConnectedComponents(g)) {
    if (component.length < 2) continue
    const members = component.map((i) => nameOf.get(i)!)
    const inside = new Set(members)
    const edges = taut.filter((e) => inside.has(e.from) && inside.has(e.to))
    out.push({ members, edges })
  }
  return out
}

// victimOf picks the edge a resolver fails to break the cycle: the
// youngest call, by call id, so the choice is deterministic and the
// oldest work survives (the database convention).
export const victimOf = (deadlock: Deadlock): AwaitEdge =>
  [...deadlock.edges].sort((a, b) => (a.callId < b.callId ? 1 : -1))[0]!

// mermaid renders the waits-for graph of the given lanes: the live
// tension picture, from the same derivation the sentinel checks.
export const mermaid = (lanes: ReadonlyMap<string, ReadonlyArray<Event>>, edgesOf: EdgesOf): string => {
  const lines = ["flowchart LR"]
  for (const [lane, events] of lanes) {
    for (const edge of edgesOf(lane, events)) {
      lines.push(`  ${lane} -->|${edge.callId}| ${edge.to}`)
    }
  }
  return lines.join("\n")
}
