import { DEFAULT_CAPACITY } from "./btree"

export type Sequence<Value> =
  | { readonly type: "leaf"; readonly values: readonly Value[]; readonly count: number; readonly height: 0 }
  | { readonly type: "branch"; readonly children: readonly Sequence<Value>[]; readonly ends: readonly number[]; readonly count: number; readonly height: number }

export function sequence<Value>(options: { readonly capacity?: number } = {}) {
  const capacity = options.capacity ?? DEFAULT_CAPACITY
  if (!Number.isSafeInteger(capacity) || capacity < 3) throw new RangeError("capacity must be a safe integer of at least three")
  const metrics = { visits: 0, pages: 0, slots: 0 }
  const copy = <Item>(items: readonly Item[], start = 0, end = items.length): Item[] => {
    metrics.slots += end - start
    return items.slice(start, end)
  }
  const leaf = (values: Value[]): Sequence<Value> => {
    metrics.pages++
    return Object.freeze({ type: "leaf", values: Object.freeze(values), count: values.length, height: 0 })
  }
  const branch = (children: Sequence<Value>[]): Sequence<Value> => {
    let count = 0
    const ends = children.map(child => count += child.count)
    if (!Number.isSafeInteger(count)) throw new RangeError("sequence length exceeds safe integer range")
    metrics.pages++; metrics.slots += ends.length
    return Object.freeze({ type: "branch", children: Object.freeze(children), ends: Object.freeze(ends), count, height: children[0]!.height + 1 })
  }
  const empty = leaf([])
  const pack = <Item>(items: Item[], build: (items: Item[]) => Sequence<Value>): Sequence<Value>[] => {
    if (items.length <= capacity) return [build(items)]
    const middle = Math.floor(items.length / 2)
    return [build(copy(items, 0, middle)), build(copy(items, middle))]
  }
  const root = (children: Sequence<Value>[]): Sequence<Value> => children.length === 0 ? empty : children.length === 1 ? children[0]! : branch(children)
  const locate = (page: Extract<Sequence<Value>, { type: "branch" }>, index: number): number => {
    let low = 0, high = page.ends.length - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (index < page.ends[middle]!) high = middle
      else low = middle + 1
    }
    return low
  }
  const joinPages = (left: Sequence<Value>, right: Sequence<Value>): Sequence<Value>[] => {
    metrics.visits += 2
    if (left.height === right.height) {
      if (left.type === "leaf" && right.type === "leaf") {
        const values = [...left.values, ...right.values]; metrics.slots += values.length
        return pack(values, leaf)
      }
      if (left.type === "branch" && right.type === "branch") {
        const children = [...left.children, ...right.children]; metrics.slots += children.length
        return pack(children, branch)
      }
      throw new Error("Sequence levels differ")
    }
    if (left.height > right.height && left.type === "branch") {
      const children = copy(left.children, 0, left.children.length - 1)
      const tail = joinPages(left.children.at(-1)!, right)
      children.push(...tail); metrics.slots += tail.length
      return pack(children, branch)
    }
    if (right.type !== "branch") throw new Error("Sequence levels differ")
    const head = joinPages(left, right.children[0]!)
    const children = [...head, ...copy(right.children, 1)]; metrics.slots += children.length
    return pack(children, branch)
  }
  const concat = (left: Sequence<Value>, right: Sequence<Value>): Sequence<Value> => {
    if (left.count === 0) return right
    if (right.count === 0) return left
    const pages = joinPages(left, right)
    if (pages.length === 1) return pages[0]!
    metrics.slots += pages.length
    return branch(pages)
  }
  const split = (page: Sequence<Value>, index: number): readonly [Sequence<Value>, Sequence<Value>] => {
    if (index === 0) return [empty, page]
    if (index === page.count) return [page, empty]
    metrics.visits++
    if (page.type === "leaf") return [leaf(copy(page.values, 0, index)), leaf(copy(page.values, index))]
    const child = locate(page, index), offset = child === 0 ? 0 : page.ends[child - 1]!
    const [left, right] = split(page.children[child]!, index - offset)
    return [concat(root(copy(page.children, 0, child)), left), concat(right, root(copy(page.children, child + 1)))]
  }
  const from = (values: readonly Value[]): Sequence<Value> => {
    if (values.length === 0) return empty
    const groups = <Item>(items: readonly Item[], build: (items: Item[]) => Sequence<Value>): Sequence<Value>[] => {
      const pages = Math.ceil(items.length / capacity), width = Math.floor(items.length / pages), extra = items.length % pages
      const result: Sequence<Value>[] = []
      let offset = 0
      for (let index = 0; index < pages; index++) {
        const end = offset + width + (index < extra ? 1 : 0)
        result.push(build(copy(items, offset, end))); offset = end
      }
      return result
    }
    let pages = groups(values, leaf)
    while (pages.length > 1) pages = groups(pages, branch)
    return pages[0]!
  }
  const check = (index: number, maximum: number) => {
    if (!Number.isSafeInteger(index) || index < 0 || index > maximum) throw new RangeError("sequence index out of bounds")
  }
  const scan = function* (page: Sequence<Value>, start = 0, end = page.count): IterableIterator<Value> {
    check(start, page.count); check(end, page.count)
    if (end < start) throw new RangeError("sequence range is reversed")
    if (start === end) return
    metrics.visits++
    if (page.type === "leaf") { for (let index = start; index < end; index++) yield page.values[index]!; return }
    let index = locate(page, start)
    while (index < page.children.length) {
      const offset = index === 0 ? 0 : page.ends[index - 1]!
      if (offset >= end) break
      yield* scan(page.children[index]!, Math.max(0, start - offset), Math.min(page.children[index]!.count, end - offset))
      index++
    }
  }
  const set = (page: Sequence<Value>, index: number, value: Value): Sequence<Value> => {
    metrics.visits++
    if (page.type === "leaf") {
      if (Object.is(page.values[index], value)) return page
      const values = copy(page.values); values[index] = value
      return leaf(values)
    }
    const position = locate(page, index), previous = page.children[position]!
    const next = set(previous, index - (position === 0 ? 0 : page.ends[position - 1]!), value)
    if (next === previous) return page
    const children = copy(page.children); children[position] = next
    return branch(children)
  }
  return {
    capacity, empty: () => empty, from, scan,
    get: (page: Sequence<Value>, index: number): Value => {
      check(index, page.count - 1)
      while (true) {
        metrics.visits++
        if (page.type === "leaf") return page.values[index]!
        const child = locate(page, index)
        index -= child === 0 ? 0 : page.ends[child - 1]!
        page = page.children[child]!
      }
    },
    set: (page: Sequence<Value>, index: number, value: Value): Sequence<Value> => { check(index, page.count - 1); return set(page, index, value) },
    splice: (page: Sequence<Value>, start: number, deleteCount: number, items: readonly Value[] = []): Sequence<Value> => {
      check(start, page.count); check(deleteCount, page.count - start)
      if (deleteCount === 0 && items.length === 0) return page
      const [left, rest] = split(page, start), [, right] = split(rest, deleteCount)
      return concat(concat(left, from(items)), right)
    },
    stats: () => ({ ...metrics }),
    resetStats: () => { metrics.visits = 0; metrics.pages = 0; metrics.slots = 0 },
  }
}
