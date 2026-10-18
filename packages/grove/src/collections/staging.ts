import type { Node } from "../storage/nodes"

interface Version { readonly hash: string }
interface Write { readonly node: Version; readonly parent?: Version }

// snapshotWrites returns pending writes in dependency order (test/append-only.test.ts; test/mvcc.ts).
export function snapshotWrites<Value extends Write>(pending: ReadonlyMap<string, Value>, nodes: Iterable<Node>, tag: "l" | "m"): readonly Value[] {
  const writes: Value[] = [], seen = new Set<string>()
  const visit = (node: Version) => {
    if (seen.has(node.hash)) return
    seen.add(node.hash)
    const write = pending.get(node.hash)
    if (!write) return
    if (write.parent) visit(write.parent)
    writes.push(write)
  }
  for (const node of nodes) if (node.tag === tag) visit(node)
  return Object.freeze(writes)
}
