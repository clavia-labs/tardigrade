import { expect, test } from "bun:test"
import fc from "fast-check"
import { sequence, type Sequence } from "./sequence"

function invariant<Value>(page: Sequence<Value>, capacity: number, isRoot = true): number {
  const slots = page.type === "leaf" ? page.values.length : page.children.length
  expect(Object.isFrozen(page)).toBe(true)
  expect(slots).toBeLessThanOrEqual(capacity)
  expect(slots).toBeGreaterThanOrEqual(isRoot ? page.type === "leaf" ? 0 : 2 : Math.ceil(capacity / 2))
  if (page.type === "leaf") {
    expect(Object.isFrozen(page.values)).toBe(true)
    expect(page.height).toBe(0)
    expect(page.count).toBe(slots)
    return slots
  }
  expect(Object.isFrozen(page.children)).toBe(true)
  expect(Object.isFrozen(page.ends)).toBe(true)
  let count = 0
  for (let index = 0; index < page.children.length; index++) {
    const child = page.children[index]!
    expect(child.height).toBe(page.height - 1)
    count += invariant(child, capacity, false)
    expect(page.ends[index]).toBe(count)
  }
  expect(page.count).toBe(count)
  return count
}

test("ranked edits match arrays and retain balanced snapshots", () => {
  fc.assert(fc.property(
    fc.integer({ min: 3, max: 12 }),
    fc.array(fc.record({ position: fc.nat(1000), removed: fc.nat(40), values: fc.array(fc.integer(), { maxLength: 30 }), replace: fc.boolean() }), { minLength: 100, maxLength: 300 }),
    (capacity, edits) => {
      const tree = sequence<number>({ capacity })
      let root = tree.empty(), model: number[] = []
      const retained: Array<readonly [Sequence<number>, number[]]> = []
      for (let step = 0; step < edits.length; step++) {
        const edit = edits[step]!, start = edit.position % (model.length + 1)
        if (edit.replace && start < model.length) {
          root = tree.set(root, start, edit.position); model[start] = edit.position
        } else {
          const removed = Math.min(edit.removed, model.length - start)
          root = tree.splice(root, start, removed, edit.values); model.splice(start, removed, ...edit.values)
        }
        invariant(root, capacity)
        expect([...tree.scan(root)]).toEqual(model)
        if (model.length > 0) {
          const index = edit.position % model.length
          expect(tree.get(root, index)).toBe(model[index]!)
          expect([...tree.scan(root, index, Math.min(model.length, index + 7))]).toEqual(model.slice(index, index + 7))
        }
        if (step % 31 === 0) retained.push([root, [...model]])
      }
      for (const [snapshot, values] of retained) expect([...tree.scan(snapshot)]).toEqual(values)
    },
  ), { numRuns: 150, seed: 20261020 })
}, 30_000)

test("sequence boundaries, no-ops, sharing and root contraction", () => {
  const tree = sequence<number>({ capacity: 4 }), root = tree.from(Array.from({ length: 1000 }, (_, index) => index))
  expect(tree.splice(root, 0, 0)).toBe(root)
  expect(tree.set(root, 10, 10)).toBe(root)
  const next = tree.splice(root, 0, 1, [-1])
  const pages = (page: Sequence<number>, result = new Set<Sequence<number>>()): Set<Sequence<number>> => {
    result.add(page)
    if (page.type === "branch") for (const child of page.children) pages(child, result)
    return result
  }
  const previous = pages(root)
  expect([...pages(next)].filter(page => previous.has(page)).length).toBeGreaterThan(100)
  expect([...tree.scan(tree.splice(root, 0, root.count))]).toEqual([])
  expect(tree.splice(root, 0, root.count, [9]).height).toBe(0)
  for (const index of [-1, 1000, 0.5, NaN]) expect(() => tree.get(root, index)).toThrow(RangeError)
  expect(() => tree.splice(root, 0, 1001)).toThrow(RangeError)
  expect(() => [...tree.scan(root, 2, 1)]).toThrow(RangeError)
  for (const capacity of [0, 2, 3.5, Infinity]) expect(() => sequence({ capacity })).toThrow(RangeError)
})

test("splice work follows height and inserted size across growing arrays", () => {
  for (const capacity of [3, 4, 8, 32, 64]) {
    const tree = sequence<number>({ capacity })
    for (const count of [1000, 10_000, 100_000]) {
      const root = tree.from(Array.from({ length: count }, (_, index) => index)), levels = root.height + 1
      for (const start of [0, 1, Math.floor(count / 2), count - 1, count]) {
        tree.resetStats()
        const next = tree.splice(root, start, Math.min(count - start, Math.floor(count / 3)), [-1])
        const metrics = tree.stats()
        expect(metrics.visits).toBeLessThanOrEqual(40 * levels)
        expect(metrics.pages).toBeLessThanOrEqual(40 * levels)
        expect(metrics.slots).toBeLessThanOrEqual(80 * capacity * levels)
        expect(next.count).toBe(count - Math.min(count - start, Math.floor(count / 3)) + 1)
        expect(tree.get(next, start)).toBe(-1)
      }
      tree.resetStats(); expect(tree.get(root, Math.floor(count / 2))).toBe(Math.floor(count / 2))
      expect(tree.stats().visits).toBe(levels)
      tree.resetStats(); tree.set(root, Math.floor(count / 2), -1)
      expect(tree.stats().pages).toBe(levels)
      tree.resetStats(); expect([...tree.scan(root, count - 10)].length).toBe(10)
      expect(tree.stats().visits).toBeLessThanOrEqual(levels + 20)
    }
  }
}, 30_000)


test("sequence grows and contracts through both edges and bulk replacements", () => {
  for (const capacity of [3, 4, 5, 8]) {
    for (const front of [true, false]) {
      const tree = sequence<number>({ capacity })
      let root = tree.empty()
      for (let index = 0; index < 500; index++) {
        root = tree.splice(root, front ? 0 : root.count, 0, [index])
        invariant(root, capacity)
      }
      for (let index = 0; index < 500; index++) {
        root = tree.splice(root, front ? 0 : root.count - 1, 1)
        invariant(root, capacity)
      }
      expect(root.count).toBe(0)
      const original = tree.from(Array.from({ length: 10_000 }, (_, index) => index))
      const items = Array.from({ length: 5000 }, (_, index) => -index)
      tree.resetStats()
      const replaced = tree.splice(original, 13, 9000, items)
      const work = tree.stats()
      expect(work.pages).toBeLessThan(40 * (original.height + 1) + 4 * Math.ceil(items.length / capacity))
      expect(work.slots).toBeLessThan(80 * capacity * (original.height + 1) + 8 * items.length)
      invariant(replaced, capacity)
      expect([...tree.scan(replaced)]).toEqual([...Array.from({ length: 13 }, (_, index) => index), ...items, ...Array.from({ length: 987 }, (_, index) => index + 9013)])
    }
  }
}, 30_000)
