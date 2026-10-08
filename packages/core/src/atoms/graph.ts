import type { AtomRegistry } from "effect/reactivity"
import type { Atom } from "./atom"

export interface ActorGraph {
  readonly nodes: readonly { readonly id: string; readonly label: string; readonly root: boolean }[]
  readonly edges: readonly { readonly from: string; readonly to: string }[]
  readonly mermaid: string
}

// actorGraph snapshots observed dependencies, collapsing unnamed intermediate atoms without exposing their values.
export function actorGraph(registry: AtomRegistry.AtomRegistry, roots: Readonly<Record<string, Atom<unknown>>>): ActorGraph {
  for (const root of Object.values(roots)) registry.get(root)
  type Node = AtomRegistry.Node<unknown>
  const names = new Map(Object.entries(roots).map(([name, node]) => [node, name]))
  const reachable = new Set<Node>()
  const visit = (node: Node) => {
    if (reachable.has(node)) return
    reachable.add(node)
    for (const parent of node.parents) visit(parent)
  }
  for (const node of registry.getNodes().values()) if (names.has(node.atom)) visit(node)
  const visible = [...reachable].filter(node => names.has(node.atom) || node.atom.label || !node.parents.size)
  const ids = new Map(visible.map((node, index) => [node, `n${index}`]))
  const nodes = visible.map(node => ({
    id: ids.get(node)!, label: names.get(node.atom) ?? node.atom.label?.[0] ?? `atom ${ids.get(node)}`, root: names.has(node.atom),
  }))
  const edges: { from: string; to: string }[] = []
  for (const target of visible) {
    const seen = new Set<Node>([target])
    const connect = (node: Node) => {
      if (seen.has(node)) return
      seen.add(node)
      const from = ids.get(node)
      if (from) edges.push({ from, to: ids.get(target)! })
      else for (const parent of node.parents) connect(parent)
    }
    for (const parent of target.parents) connect(parent)
  }
  const escape = (label: string) => Array.from(label, char => /[a-zA-Z0-9 _-]/.test(char) ? char : `#${char.codePointAt(0)};`).join("")
  const mermaid = ["flowchart LR", ...nodes.map(node => `  ${node.id}["${escape(node.label)}"]`), ...edges.map(edge => `  ${edge.from} --> ${edge.to}`)].join("\n")
  return { nodes, edges, mermaid }
}
