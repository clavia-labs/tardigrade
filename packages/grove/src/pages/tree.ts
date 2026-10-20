export const DEFAULT_CAPACITY = 32

export type Key = string | null
export type Entry<K extends Key, V> = readonly [K, V]
interface Metadata<K extends Key> {
  readonly count: number
  readonly height: number
  readonly width: number
  readonly last: K | undefined
}
export interface Leaf<K extends Key, V> extends Metadata<K> {
  readonly type: "leaf"
  readonly entries: readonly Entry<K, V>[]
}
export interface Branch<K extends Key, V> extends Metadata<K> {
  readonly type: "branch"
  readonly children: readonly Node<K, V>[]
}
export interface Reference<K extends Key> extends Metadata<K> {
  readonly type: "stored"
  readonly id: number
}
export type Page<K extends Key, V> = Leaf<K, V> | Branch<K, V>
export type Node<K extends Key, V> = Page<K, V> | Reference<K>
export interface Options<K extends Key, V> {
  readonly capacity?: number
  readonly load?: (id: number) => Page<K, V>
  readonly allocated?: (page: Page<K, V>) => void
}

// reference preserves page navigation metadata across storage placement (test/page-tree.test.ts).
export function reference<K extends Key, V>(page: Page<K, V>, id: number): Reference<K> {
  if (!Number.isSafeInteger(id) || id < 1) throw new RangeError("Page id must be a positive safe integer")
  return Object.freeze({ type: "stored", id, count: page.count, height: page.height, width: page.width, last: page.last })
}

// tree shares copy-on-write balancing between keyed and ranked pages (test/page-tree.test.ts).
export function tree<K extends Key, V>(options: Options<K, V> = {}) {
  const capacity = options.capacity ?? DEFAULT_CAPACITY
  if (!Number.isSafeInteger(capacity) || capacity < 4) throw new RangeError("Page capacity must be a safe integer of at least four")
  const minimum = Math.ceil(capacity / 2)
  const tuple = ([key, value]: Entry<K, V>): Entry<K, V> => Object.freeze([key, value])
  const made = <P extends Page<K, V>>(page: P): P => { options.allocated?.(page); return page }
  const leaf = (entries: readonly Entry<K, V>[]): Leaf<K, V> => made(Object.freeze({
    type: "leaf", entries: Object.freeze(entries), count: entries.length, height: 0, width: entries.length, last: entries.at(-1)?.[0],
  }))
  const branch = (children: readonly Node<K, V>[]): Branch<K, V> => {
    if (!children.length || children.some(child => !child.count || child.height !== children[0]!.height)) throw new Error("Invalid branch children")
    const count = children.reduce((count, child) => count + child.count, 0)
    if (!Number.isSafeInteger(count)) throw new RangeError("Tree size exceeds safe integer range")
    return made(Object.freeze({ type: "branch", children: Object.freeze(children), count, height: children[0]!.height + 1, width: children.length, last: children.at(-1)!.last }))
  }
  const read = (node: Node<K, V>): Page<K, V> => {
    if (node.type !== "stored") return node
    if (!options.load) throw new Error(`Page ${node.id} is unavailable`)
    const page = options.load(node.id)
    const entries = page.type === "leaf" ? page.entries : page.children
    const count = page.type === "leaf" ? entries.length : page.children.reduce((count, child) => count + child.count, 0)
    const height = page.type === "leaf" ? 0 : (page.children[0]?.height ?? -1) + 1
    const last = page.type === "leaf" ? page.entries.at(-1)?.[0] : page.children.at(-1)?.last
    if (page.width > capacity || page.width !== entries.length || page.count !== count || page.height !== height || page.last !== last ||
      !Number.isSafeInteger(count) || count < 0 || page.type === "branch" && (!page.children.length || page.children.some(child => child.count < 1 || child.height !== height - 1)) ||
      page.count !== node.count || page.height !== node.height || page.width !== node.width || page.last !== node.last) throw new Error(`Page ${node.id} metadata mismatch`)
    return page
  }
  const bounds = (index: number, maximum: number) => {
    if (!Number.isSafeInteger(index) || index < 0 || index > maximum) throw new RangeError("Index out of bounds")
  }
  const locate = (children: readonly Node<K, V>[], index: number) => {
    let offset = index, child = 0
    while (child < children.length - 1 && offset >= children[child]!.count) offset -= children[child++]!.count
    return { child, offset }
  }
  const packLeaves = (entries: readonly Entry<K, V>[]): readonly Page<K, V>[] => {
    if (entries.length <= capacity) return [leaf(entries)]
    const middle = Math.floor(entries.length / 2)
    return [leaf(entries.slice(0, middle)), leaf(entries.slice(middle))]
  }
  const packBranches = (children: readonly Node<K, V>[]): readonly Page<K, V>[] => {
    if (children.length <= capacity) return [branch(children)]
    const middle = Math.floor(children.length / 2)
    return [branch(children.slice(0, middle)), branch(children.slice(middle))]
  }
  const insertAt = (node: Node<K, V>, index: number, entry: Entry<K, V>): readonly Page<K, V>[] => {
    const page = read(node)
    if (page.type === "leaf") {
      const entries = [...page.entries]; entries.splice(index, 0, entry)
      return packLeaves(entries)
    }
    const { child, offset } = locate(page.children, index), children = [...page.children]
    children.splice(child, 1, ...insertAt(children[child]!, offset, entry))
    return packBranches(children)
  }
  const replaceAt = (node: Node<K, V>, index: number, entry: Entry<K, V>): Page<K, V> => {
    const page = read(node)
    if (page.type === "leaf") {
      const entries = [...page.entries]; entries[index] = entry
      return leaf(entries)
    }
    const { child, offset } = locate(page.children, index), children = [...page.children]
    children[child] = replaceAt(children[child]!, offset, entry)
    return branch(children)
  }
  const joinPair = (left: Node<K, V>, right: Node<K, V>): readonly Page<K, V>[] => {
    const a = read(left), b = read(right)
    if (a.type === "leaf" && b.type === "leaf") return packLeaves([...a.entries, ...b.entries])
    if (a.type === "branch" && b.type === "branch") return packBranches([...a.children, ...b.children])
    throw new Error("Sibling heights differ")
  }
  const rootOf = (children: readonly Node<K, V>[]): Node<K, V> => children.length === 0 ? leaf([]) : children.length === 1 ? children[0]! : branch(children)
  const join = (left: Node<K, V>, right: Node<K, V>): Node<K, V> => {
    if (!left.count) return right
    if (!right.count) return left
    if (left.height === right.height) return rootOf(joinPair(left, right))
    if (left.height > right.height) {
      const page = read(left)
      if (page.type !== "branch") throw new Error("Invalid join height")
      const children = [...page.children], next = join(children.pop()!, right)
      if (next.height === left.height) {
        const expanded = read(next)
        if (expanded.type !== "branch") throw new Error("Invalid join result")
        children.push(...expanded.children)
      } else children.push(next)
      return rootOf(packBranches(children))
    }
    const page = read(right)
    if (page.type !== "branch") throw new Error("Invalid join height")
    const children = [...page.children], next = join(left, children.shift()!)
    if (next.height === right.height) {
      const expanded = read(next)
      if (expanded.type !== "branch") throw new Error("Invalid join result")
      children.unshift(...expanded.children)
    } else children.unshift(next)
    return rootOf(packBranches(children))
  }
  const split = (node: Node<K, V>, index: number): readonly [Node<K, V>, Node<K, V>] => {
    bounds(index, node.count)
    if (index === 0) return [leaf([]), node]
    if (index === node.count) return [node, leaf([])]
    const page = read(node)
    if (page.type === "leaf") return [leaf(page.entries.slice(0, index)), leaf(page.entries.slice(index))]
    const { child, offset } = locate(page.children, index)
    const [left, right] = split(page.children[child]!, offset)
    return [join(rootOf(page.children.slice(0, child)), left), join(right, rootOf(page.children.slice(child + 1)))]
  }
  const removeAt = (node: Node<K, V>, index: number): Page<K, V> => {
    const page = read(node)
    if (page.type === "leaf") {
      const entries = [...page.entries]; entries.splice(index, 1)
      return leaf(entries)
    }
    const { child, offset } = locate(page.children, index), children = [...page.children]
    children[child] = removeAt(children[child]!, offset)
    if (children[child]!.width < minimum && children.length > 1) {
      const start = Math.max(0, child - 1)
      children.splice(start, 2, ...joinPair(children[start]!, children[start + 1]!))
    }
    return branch(children)
  }
  const groups = <T>(items: readonly T[], make: (items: readonly T[]) => Page<K, V>): Page<K, V>[] => {
    const count = Math.ceil(items.length / capacity), size = Math.floor(items.length / count), extra = items.length % count
    const pages: Page<K, V>[] = []
    let start = 0
    for (let index = 0; index < count; index++) {
      const end = start + size + Number(index < extra)
      pages.push(make(items.slice(start, end))); start = end
    }
    return pages
  }
  const scan = function* (node: Node<K, V>, start = 0, end = node.count): Generator<Entry<K, V>> {
    bounds(start, node.count); bounds(end, node.count)
    if (end < start) throw new RangeError("Range end precedes start")
    if (start === end) return
    const page = read(node)
    if (page.type === "leaf") {
      for (let index = start; index < end; index++) yield page.entries[index]!
      return
    }
    let offset = 0
    for (const child of page.children) {
      if (offset >= end) break
      if (offset + child.count > start) yield* scan(child, Math.max(0, start - offset), Math.min(child.count, end - offset))
      offset += child.count
    }
  }
  return {
    capacity, minimum, read,
    empty: (): Page<K, V> => leaf([]),
    from: (input: readonly Entry<K, V>[]): Page<K, V> => {
      if (!input.length) return leaf([])
      let pages = groups(input.map(tuple), leaf)
      while (pages.length > 1) pages = groups(pages, branch)
      return pages[0]!
    },
    get: (node: Node<K, V>, index: number): Entry<K, V> => {
      bounds(index, node.count - 1)
      let current = node, offset = index
      while (true) {
        const page = read(current)
        if (page.type === "leaf") return page.entries[offset]!
        const position = locate(page.children, offset)
        current = page.children[position.child]!; offset = position.offset
      }
    },
    insert: (node: Node<K, V>, index: number, entry: Entry<K, V>): Page<K, V> => {
      bounds(index, node.count)
      const pages = insertAt(node, index, tuple(entry))
      return pages.length === 1 ? pages[0]! : branch(pages)
    },
    set: (node: Node<K, V>, index: number, entry: Entry<K, V>): Page<K, V> => {
      bounds(index, node.count - 1)
      return replaceAt(node, index, tuple(entry))
    },
    remove: (node: Node<K, V>, index: number): Node<K, V> => {
      bounds(index, node.count - 1)
      let next: Node<K, V> = removeAt(node, index)
      while (next.type === "branch" && next.children.length === 1) next = next.children[0]!
      return next
    },
    seek: (node: Node<K, V>, key: K, compare: (a: K, b: K) => number): { readonly index: number; readonly found: boolean } => {
      let current = node, index = 0
      while (true) {
        const page = read(current)
        if (page.type === "leaf") {
          let low = 0, high = page.entries.length
          while (low < high) {
            const middle = (low + high) >>> 1
            if (compare(page.entries[middle]![0], key) < 0) low = middle + 1
            else high = middle
          }
          return { index: index + low, found: low < page.entries.length && compare(page.entries[low]![0], key) === 0 }
        }
        let low = 0, high = page.children.length
        while (low < high) {
          const middle = (low + high) >>> 1
          if (compare(page.children[middle]!.last!, key) < 0) low = middle + 1
          else high = middle
        }
        const child = Math.min(low, page.children.length - 1)
        for (let before = 0; before < child; before++) index += page.children[before]!.count
        current = page.children[child]!
      }
    },
    scan, split, join,
  }
}
