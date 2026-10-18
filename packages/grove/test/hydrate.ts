import { decodeNode, matchNode, plan, type Node, type Tree } from "../src/storage/nodes"

export function hydrate(root: string, texts: ReadonlyMap<string, string>): Tree {
  const active = new Set<string>()
  const ready = new Map<string, Node>()
  const read = (hash: string): Node => {
    const cached = ready.get(hash)
    if (cached) return cached
    if (active.has(hash)) throw new Error("Shared JSON graph contains a cycle")
    const text = texts.get(hash)
    if (text === undefined) throw new Error(`Shared JSON node missing or corrupt: ${hash}`)
    active.add(hash)
    const decoded = decodeNode(hash, text)
    const links = decoded.links.map(child => matchNode(child, read(child.hash)))
    const node = Object.freeze({ ...decoded, links: Object.freeze(links) })
    active.delete(hash)
    ready.set(hash, node)
    return node
  }
  return plan(read(root), { hashedNodes: 0, hashedBytes: 0, visitedValues: 0, reusedNodes: 0 })
}
