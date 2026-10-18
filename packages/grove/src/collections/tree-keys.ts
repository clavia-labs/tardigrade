import { bytes, descriptor, payload, type Descriptor, type Node } from "../storage/nodes"

export type KeyedEntry = readonly [key: string, order: number, value: Node]
type StoredEntry = readonly [string, number, Descriptor]
type Create = (tag: Node["tag"], payload: unknown, links: readonly Node[], logicalBytes: number, count?: number, level?: number) => Node
export const keyedEntries = (node: Node): readonly KeyedEntry[] => {
  if (node.tag !== "k") throw new Error("Expected keyed page")
  return (payload(node) as readonly StoredEntry[]).map(([key, order], index) => [key, order, node.links[index]!])
}
export const keyedIndex = (node: Node, key: string): number => {
  const index = node.links.findIndex(child => key <= child.lastKey!)
  return index < 0 ? node.links.length - 1 : index
}

// makeKeyed maintains key-sorted pages and insertion ordinals for JSON enumeration (test/keyed.test.ts).
export function makeKeyed(create: Create, pageItems: number, fanout: number) {
  const page = (entries: readonly KeyedEntry[]): Node => Object.freeze({
    ...create("k", entries.map(([key, order, value]) => [key, order, descriptor(value)]), entries.map(entry => entry[2]), 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, , value]) => sum + bytes(JSON.stringify(key)) + 1 + value.logicalBytes, 0), entries.length),
    order: entries.reduce((max, entry) => Math.max(max, entry[1]), 0), firstKey: entries[0]?.[0] ?? null, lastKey: entries.at(-1)?.[0] ?? null,
  })
  const branch = (children: readonly Node[]): Node => Object.freeze({
    ...create("b", children.map(descriptor), children, 2 + children.reduce((sum, child) => sum + child.logicalBytes - 2, 0) + children.length - 1, children.reduce((sum, child) => sum + child.count, 0), children[0]!.level + 1),
    order: children.reduce((max, child) => Math.max(max, child.order!), 0), firstKey: children[0]!.firstKey!, lastKey: children.at(-1)!.lastKey!,
  })
  const split = (node: Node): readonly Node[] => {
    const count = node.links.length, capacity = node.tag === "k" ? pageItems : fanout
    if (count <= capacity) return [node]
    const groups = Math.ceil(count / capacity), result: Node[] = []
    const entries = node.tag === "k" ? keyedEntries(node) : undefined
    for (let index = 0; index < groups; index++) {
      const start = Math.floor(index * count / groups), end = Math.floor((index + 1) * count / groups)
      result.push(entries ? page(entries.slice(start, end)) : branch(node.links.slice(start, end)))
    }
    return result
  }
  const finish = (nodes: readonly Node[]): Node => {
    let level = nodes
    while (level.length > 1) {
      const groups = Math.ceil(level.length / fanout), next: Node[] = []
      for (let index = 0; index < groups; index++) next.push(branch(level.slice(Math.floor(index * level.length / groups), Math.floor((index + 1) * level.length / groups))))
      level = next
    }
    let root = level[0]!
    while (root.tag === "b" && root.links.length === 1) root = root.links[0]!
    return root
  }
  const build = (fields: readonly (readonly [string, Node])[]): Node => {
    const entries: KeyedEntry[] = fields.map(([key, value], order) => [key, order, value])
    entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    const level: Node[] = []
    const pages = Math.max(1, Math.ceil(entries.length / pageItems))
    for (let index = 0; index < pages; index++) level.push(page(entries.slice(Math.floor(index * entries.length / pages), Math.floor((index + 1) * entries.length / pages))))
    return finish(level)
  }
  const change = (node: Node, key: string, order: number, update: (value: Node | undefined) => Node | undefined, remove: boolean): readonly Node[] => {
    if (node.opaque) throw new Error("Keyed edit requires an explicit read")
    if (node.tag === "k") {
      const entries = [...keyedEntries(node)], index = entries.findIndex(entry => entry[0] === key)
      const previous = index < 0 ? undefined : entries[index]!
      const value = update(previous?.[2])
      if (!value && !previous || value === previous?.[2]) return [node]
      if (!value) entries.splice(index, 1)
      else if (previous) entries[index] = [key, previous[1], value]
      else {
        if (!Number.isSafeInteger(order)) throw new Error("Keyed insertion ordinal exceeds safe integer precision")
        entries.push([key, order, value]); entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      }
      return split(page(entries))
    }
    if (node.tag !== "b") throw new Error("Expected keyed branch")
    const index = keyedIndex(node, key), old = node.links[index]!
    const changed = change(old, key, order, update, remove)
    if (changed.length === 1 && changed[0] === old) return [node]
    const children = [...node.links]
    children.splice(index, 1, ...changed.filter(child => child.count > 0))
    if (!children.length) return [page([])]
    const current = children[Math.min(index, children.length - 1)]!
    const capacity = current.tag === "k" ? pageItems : fanout
    if (remove && children.length > 1 && !current.opaque && current.links.length < Math.ceil(capacity / 2)) {
      const left = Math.max(0, Math.min(index, children.length - 1) - 1)
      const first = children[left]!, second = children[left + 1]!
      if (first.opaque || second.opaque) throw new Error("Keyed rebalance requires an explicit read")
      const joined = first.tag === "k" ? page([...keyedEntries(first), ...keyedEntries(second)]) : branch([...first.links, ...second.links])
      children.splice(left, 2, ...split(joined))
    }
    return split(branch(children))
  }
  const edit = (root: Node, key: string, update: (value: Node | undefined) => Node | undefined, remove = false) => finish(change(root, key, root.order! + 1, update, remove))
  return { build, edit }
}
