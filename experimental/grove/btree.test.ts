import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import fc from "fast-check"
import { btree, type Page } from "./btree"

const compare = (a: number, b: number) => a - b
const entries = (map: ReadonlyMap<number, number>) => [...map].sort(([a], [b]) => a - b)
const invariant = (root: Page<number, number>, capacity: number) => {
  const walk = (page: Page<number, number>, isRoot: boolean): number[] => {
    const count = page.type === "leaf" ? page.entries.length : page.children.length
    assert(count <= capacity)
    assert(count >= (isRoot ? page.type === "leaf" ? 0 : 2 : Math.ceil(capacity / 2)))
    assert(Object.isFrozen(page))
    if (page.type === "leaf") {
      assert(Object.isFrozen(page.entries))
      assert.equal(page.height, 0)
      assert.equal(page.minimum, page.entries[0]?.[0])
      const keys = page.entries.map(([key]) => key)
      assert(keys.every((key, index) => index === 0 || keys[index - 1]! < key))
      return keys
    }
    assert(Object.isFrozen(page.children) && Object.isFrozen(page.separators))
    assert.equal(page.separators.length, page.children.length - 1)
    const keys: number[] = []
    for (const [index, child] of page.children.entries()) {
      assert.equal(child.height, page.height - 1)
      const found = walk(child, false)
      assert(found.length > 0)
      if (index) { assert(keys.at(-1)! < found[0]!); assert.equal(page.separators[index - 1], found[0]) }
      keys.push(...found)
    }
    assert.equal(page.minimum, keys[0])
    return keys
  }
  walk(root, true)
}

const pathSlots = (page: Page<number, number>, key: number): number => {
  if (page.type === "leaf") return page.entries.length
  const index = page.separators.findIndex(separator => key < separator)
  return page.children.length + pathSlots(page.children[index < 0 ? page.children.length - 1 : index]!, key)
}

const edit = fc.record({ operation: fc.constantFrom("set", "delete", "read"), key: fc.integer({ min: -80, max: 80 }), value: fc.integer(), other: fc.integer({ min: -100, max: 100 }), reverse: fc.boolean() })

test("generated histories preserve occupancy, separators, equal depth, ranges and snapshots", () => {
  fc.assert(fc.property(fc.integer({ min: 3, max: 12 }), fc.array(edit, { minLength: 100, maxLength: 400 }), (capacity, edits) => {
    const tree = btree<number, number>(compare, { capacity }), model = new Map<number, number>()
    let root = tree.empty()
    const versions: Array<{ root: Page<number, number>; expected: [number, number][] }> = []
    for (const [sequence, step] of edits.entries()) {
      if (sequence % 17 === 0) versions.push({ root, expected: entries(model) })
      if (step.operation === "set") { root = tree.set(root, step.key, step.value); model.set(step.key, step.value) }
      else if (step.operation === "delete") { root = tree.delete(root, step.key); model.delete(step.key) }
      else assert.equal(tree.get(root, step.key), model.get(step.key))
      invariant(root, capacity)
      assert.deepEqual([...tree.scan(root)], entries(model))
      const from = Math.min(step.key, step.other), to = Math.max(step.key, step.other)
      const selected = entries(model).filter(([key]) => key >= from && key <= to)
      assert.deepEqual([...tree.scan(root, { from, to, reverse: step.reverse })], step.reverse ? selected.reverse() : selected)
    }
    for (const version of versions) { invariant(version.root, capacity); assert.deepEqual([...tree.scan(version.root)], version.expected) }
  }), { seed: 20261020, numRuns: 200 })
}, 30_000)

test("ordered growth and deletion force splitting, redistribution, merging and root contraction", () => {
  for (const capacity of [3, 4, 5, 8, 16]) for (const reverse of [false, true]) {
    const tree = btree<number, number>(compare, { capacity })
    let root = tree.empty()
    const keys = Array.from({ length: 500 }, (_, index) => reverse ? 499 - index : index)
    for (const key of keys) { root = tree.set(root, key, key); invariant(root, capacity) }
    const snapshot = root
    for (const key of keys) { root = tree.delete(root, key); invariant(root, capacity) }
    assert.deepEqual([...tree.scan(root)], [])
    assert.equal(root.height, 0)
    assert.equal([...tree.scan(snapshot)].length, 500)
    const metrics = tree.stats()
    assert(metrics.splits > 0 && metrics.merges > 0)
  }
}, 30_000)

test("underflow borrows from a populated sibling before a later merge", () => {
  const tree = btree<number, number>(compare, { capacity: 4 })
  let root = tree.empty()
  for (let key = 0; key < 6; key++) root = tree.set(root, key, key)
  tree.resetStats()
  root = tree.delete(root, 0)
  invariant(root, 4)
  assert.equal(tree.stats().redistributions, 1)
  assert.equal(tree.stats().merges, 0)
  root = tree.delete(root, 1); root = tree.delete(root, 2)
  invariant(root, 4)
  assert(tree.stats().merges > 0)
})

test("forked versions remain independent and unchanged edits preserve root identity", () => {
  const tree = btree<number, number>(compare, { capacity: 4 })
  let root = tree.empty()
  for (let key = 0; key < 100; key++) root = tree.set(root, key, key)
  const left = tree.set(root, 20, -20), right = tree.delete(root, 90)
  assert.equal(tree.get(root, 20), 20)
  assert.equal(tree.get(root, 90), 90)
  assert.equal(tree.get(left, 20), -20)
  assert.equal(tree.get(right, 90), undefined)
  tree.resetStats()
  assert.equal(tree.set(root, 20, 20), root)
  assert.equal(tree.delete(root, 1000), root)
  assert.equal(tree.stats().pages, 0)
  assert.equal(tree.stats().slots, 0)
  if (root.type === "branch" && left.type === "branch") {
    assert.equal(left.children.at(-1), root.children.at(-1))
    assert.equal(left.separators, root.separators)
  }
})

test("empty, bounded, descending and interrupted scans visit only their navigation path", () => {
  const tree = btree<number, number>(compare, { capacity: 4 })
  let root = tree.empty()
  assert.deepEqual([...tree.scan(root)], [])
  for (let key = 0; key < 1000; key++) root = tree.set(root, key, key)
  assert.deepEqual([...tree.scan(root, { from: 20, to: 10 })], [])
  assert.deepEqual([...tree.scan(root, { from: 20, to: 10, reverse: true })], [])
  assert.deepEqual([...tree.scan(root, { to: -1, reverse: true })], [])
  assert.deepEqual([...tree.scan(root, { from: 1001 })], [])
  assert.equal([...tree.scan(root, { reverse: true })][0]![0], 999)
  tree.resetStats()
  const iterator = tree.scan(root, { from: 500 })
  assert.equal(iterator.next().value?.[0], 500)
  iterator.return?.()
  assert.equal(tree.stats().visits, root.height + 1)
  assert.equal(tree.stats().pages, 0)
})

test("point operations meet height-based comparison, page and copy budgets across scales", () => {
  for (const capacity of [3, 4, 8, 32, 64]) {
    const tree = btree<number, number>(compare, { capacity })
    let root = tree.empty(), prior = 0
    for (const length of [100, 1000, 10_000]) {
      for (let key = prior; key < length; key++) {
        tree.resetStats()
        const previous = root
        root = tree.set(root, key, key)
        assert.equal(tree.stats().visits, previous.height + 1)
        assert(tree.stats().pages <= previous.height + 1 + tree.stats().splits + Number(root.height > previous.height))
      }
      prior = length
      const path = root.height + 1, comparisons = path * (Math.ceil(Math.log2(capacity + 1)) + 1)
      assert(root.height <= Math.ceil(Math.log(Math.max(1, length)) / Math.log(Math.ceil(capacity / 2))))
      for (const key of [-1, 0, Math.floor(length / 2), length - 1, length]) {
        tree.resetStats(); tree.get(root, key)
        assert.equal(tree.stats().visits, path)
        assert(tree.stats().comparisons <= comparisons)
        assert.equal(tree.stats().pages, 0)
        tree.resetStats(); const next = tree.set(root, key, -key - 2)
        const changed = tree.stats()
        assert.equal(changed.visits, path)
        assert(changed.comparisons <= comparisons)
        assert(changed.pages <= path + changed.splits + Number(next.height > root.height), `unnecessary insertion pages: ${JSON.stringify(changed)}`)
        assert(changed.slots <= 8 * capacity * path)
        if (key >= 0 && key < length) {
          assert.equal(changed.pages, path)
          assert.equal(changed.slots, pathSlots(root, key))
        }
        tree.resetStats(); tree.delete(root, key)
        assert(tree.stats().visits <= 3 * path)
        assert(tree.stats().pages <= 4 * path)
        assert(tree.stats().slots <= 12 * capacity * path)
        assert(tree.stats().comparisons <= comparisons)
      }
      for (const count of [1, 17, 100]) for (const reverse of [false, true]) {
        const from = Math.floor(length / 3), to = Math.min(length - 1, from + count - 1), output = to - from + 1
        tree.resetStats()
        assert.equal([...tree.scan(root, { from, to, reverse })].length, output)
        assert(tree.stats().visits <= 2 * path + 2 * Math.ceil(output / (Math.ceil(capacity / 2) - 1)) + 2)
        assert(tree.stats().comparisons <= 2 * comparisons + output + 1)
        assert.equal(tree.stats().pages, 0)
      }
      tree.resetStats()
      assert.equal([...tree.scan(root)].length, length)
      assert(tree.stats().visits <= 1 + Math.ceil(2 * length / (Math.ceil(capacity / 2) - 1)))
      assert.equal(tree.stats().comparisons, 0)
      assert.equal(tree.stats().pages, 0)
    }
  }
}, 30_000)

test("capacity policy is explicit and rejects invalid branching factors", () => {
  for (const capacity of [0, 1, 2, 3.5, NaN, Infinity]) expect(() => btree(compare, { capacity })).toThrow("at least three")
})
