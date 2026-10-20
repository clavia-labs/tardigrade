export const DEFAULT_CAPACITY = 32
export type Entry<Key, Value> = readonly [Key, Value]
export type Page<Key, Value> =
  | { readonly type: "leaf"; readonly entries: readonly Entry<Key, Value>[]; readonly minimum: Key | undefined; readonly height: 0 }
  | { readonly type: "branch"; readonly children: readonly Page<Key, Value>[]; readonly separators: readonly Key[]; readonly minimum: Key; readonly height: number }
export interface Metrics { visits: number; comparisons: number; pages: number; slots: number; splits: number; merges: number; redistributions: number }
export interface Range<Key> { readonly from?: Key; readonly to?: Key; readonly reverse?: boolean }

// btree edits immutable pages; callers retain ownership of keys and values (btree.test.ts).
export function btree<Key, Value>(compare: (left: Key, right: Key) => number, options: { readonly capacity?: number } = {}) {
  const capacity = options.capacity ?? DEFAULT_CAPACITY
  if (!Number.isSafeInteger(capacity) || capacity < 3) throw new RangeError("capacity must be a safe integer of at least three")
  const minimum = Math.ceil(capacity / 2)
  const metrics: Metrics = { visits: 0, comparisons: 0, pages: 0, slots: 0, splits: 0, merges: 0, redistributions: 0 }
  const order = (left: Key, right: Key) => { metrics.comparisons++; return compare(left, right) }
  const visit = (page: Page<Key, Value>) => { metrics.visits++; return page }
  const size = (page: Page<Key, Value>) => page.type === "leaf" ? page.entries.length : page.children.length
  const copy = <Item>(items: readonly Item[], start = 0, end = items.length): Item[] => {
    metrics.slots += Math.max(0, end - start)
    return items.slice(start, end)
  }
  const leaf = (entries: Entry<Key, Value>[]): Page<Key, Value> => {
    metrics.pages++
    return Object.freeze({ type: "leaf", entries: Object.freeze(entries), minimum: entries[0]?.[0], height: 0 })
  }
  const branch = (children: Page<Key, Value>[], shared?: readonly Key[]): Page<Key, Value> => {
    metrics.pages++
    let separators = shared
    if (!separators) {
      metrics.slots += children.length - 1
      const keys: Key[] = []
      for (let index = 1; index < children.length; index++) keys.push(children[index]!.minimum!)
      separators = Object.freeze(keys)
    }
    return Object.freeze({ type: "branch", children: Object.freeze(children), separators, minimum: children[0]!.minimum!, height: children[0]!.height + 1 })
  }
  const lower = (entries: readonly Entry<Key, Value>[], key: Key): number => {
    let low = 0, high = entries.length
    while (low < high) { const middle = Math.floor((low + high) / 2); if (order(entries[middle]![0], key) < 0) low = middle + 1; else high = middle }
    return low
  }
  const childIndex = (keys: readonly Key[], key: Key): number => {
    let low = 0, high = keys.length
    while (low < high) { const middle = Math.floor((low + high) / 2); if (order(key, keys[middle]!) >= 0) low = middle + 1; else high = middle }
    return low
  }
  const replace = <Item>(items: readonly Item[], index: number, removed: number, inserted: readonly Item[]): Item[] => {
    const next = copy(items, 0, index)
    metrics.slots += inserted.length + items.length - index - removed
    for (const item of inserted) next.push(item)
    for (let offset = index + removed; offset < items.length; offset++) next.push(items[offset]!)
    return next
  }
  const pack = <Item>(items: Item[], build: (items: Item[]) => Page<Key, Value>): readonly Page<Key, Value>[] => {
    if (items.length <= capacity) return [build(items)]
    metrics.splits++
    const middle = Math.floor(items.length / 2)
    return [build(copy(items, 0, middle)), build(copy(items, middle))]
  }
  const insert = (root: Page<Key, Value>, key: Key, value: Value): readonly Page<Key, Value>[] => {
    const page = visit(root)
    if (page.type === "leaf") {
      const index = lower(page.entries, key), previous = page.entries[index]
      const found = previous !== undefined && order(previous[0], key) === 0
      if (found && Object.is(previous[1], value)) return [page]
      return pack(replace(page.entries, index, found ? 1 : 0, [Object.freeze([found ? previous[0] : key, value] as const)]), leaf)
    }
    const index = childIndex(page.separators, key), previous = page.children[index]!
    const changed = insert(previous, key, value)
    if (changed.length === 1 && changed[0] === previous) return [page]
    const children = replace(page.children, index, 1, changed)
    return changed.length === 1 && (index === 0 || Object.is(changed[0]!.minimum, previous.minimum))
      ? [branch(children, page.separators)] : pack(children, branch)
  }
  const repair = (children: Page<Key, Value>[], index: number) => {
    if (children.length < 2 || size(children[index]!) >= minimum) return
    const left = index > 0 ? index - 1 : 0
    const first = visit(children[left]!), second = visit(children[left + 1]!)
    const redistribute = <Item>(items: Item[], build: (items: Item[]) => Page<Key, Value>): readonly Page<Key, Value>[] => {
      metrics.slots += items.length
      if (items.length <= capacity) { metrics.merges++; return [build(items)] }
      metrics.redistributions++
      const middle = Math.floor(items.length / 2)
      return [build(copy(items, 0, middle)), build(copy(items, middle))]
    }
    let changed: readonly Page<Key, Value>[]
    if (first.type === "leaf" && second.type === "leaf") changed = redistribute([...first.entries, ...second.entries], leaf)
    else if (first.type === "branch" && second.type === "branch") changed = redistribute([...first.children, ...second.children], branch)
    else throw new Error("Sibling levels differ")
    children.splice(left, 2, ...changed); metrics.slots += children.length - left
  }

  const remove = (root: Page<Key, Value>, key: Key): Page<Key, Value> => {
    const page = visit(root)
    if (page.type === "leaf") {
      const index = lower(page.entries, key)
      return index === page.entries.length || order(page.entries[index]![0], key) !== 0 ? page : leaf(replace(page.entries, index, 1, []))
    }
    const index = childIndex(page.separators, key), previous = page.children[index]!, changed = remove(previous, key)
    if (changed === previous) return page
    const children = replace(page.children, index, 1, [changed])
    const underflow = size(changed) < minimum && children.length > 1
    repair(children, index)
    return branch(children, !underflow && (index === 0 || Object.is(changed.minimum, previous.minimum)) ? page.separators : undefined)
  }
  const empty = leaf([])
  const scan = function* (root: Page<Key, Value>, range: Range<Key> = {}): IterableIterator<Entry<Key, Value>> {
    const frames: Array<{ page: Extract<Page<Key, Value>, { type: "branch" }>; index: number }> = []
    const reverse = range.reverse ?? false
    const bound = reverse ? range.to : range.from
    let page = visit(root)
    while (page.type === "branch") {
      const index = bound === undefined ? reverse ? page.children.length - 1 : 0 : childIndex(page.separators, bound)
      frames.push({ page, index }); page = visit(page.children[index]!)
    }
    let index = bound === undefined ? reverse ? page.entries.length - 1 : 0 : lower(page.entries, bound)
    if (reverse && bound !== undefined && (index === page.entries.length || order(page.entries[index]![0], bound) > 0)) index--
    while (true) {
      while (index >= 0 && index < page.entries.length) {
        const entry = page.entries[index]!
        if (reverse ? range.from !== undefined && order(entry[0], range.from) < 0 : range.to !== undefined && order(entry[0], range.to) > 0) return
        yield entry
        index += reverse ? -1 : 1
      }
      let frame = frames.at(-1)
      while (frame) {
        frame.index += reverse ? -1 : 1
        if (frame.index >= 0 && frame.index < frame.page.children.length) break
        frames.pop(); frame = frames.at(-1)
      }
      if (!frame) return
      page = visit(frame.page.children[frame.index]!)
      while (page.type === "branch") {
        const next = reverse ? page.children.length - 1 : 0
        frames.push({ page, index: next }); page = visit(page.children[next]!)
      }
      index = reverse ? page.entries.length - 1 : 0
    }
  }
  return {
    capacity,
    empty: () => empty,
    get: (root: Page<Key, Value>, key: Key): Value | undefined => {
      let page = visit(root)
      while (page.type === "branch") page = visit(page.children[childIndex(page.separators, key)]!)
      const index = lower(page.entries, key), entry = page.entries[index]
      return entry !== undefined && order(entry[0], key) === 0 ? entry[1] : undefined
    },
    set: (root: Page<Key, Value>, key: Key, value: Value): Page<Key, Value> => {
      const pages = insert(root, key, value)
      return pages.length === 1 ? pages[0]! : branch(copy(pages))
    },
    delete: (root: Page<Key, Value>, key: Key): Page<Key, Value> => {
      let page = remove(root, key)
      while (page.type === "branch" && page.children.length === 1) page = page.children[0]!
      return page
    },
    scan,
    stats: (): Readonly<Metrics> => ({ ...metrics }),
    resetStats: () => { for (const key of Object.keys(metrics) as (keyof Metrics)[]) metrics[key] = 0 },
  }
}
