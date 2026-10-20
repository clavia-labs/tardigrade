import { expect, test } from "bun:test"
import fc from "fast-check"
import { tree, reference, DEFAULT_CAPACITY, type Entry, type Key, type Node, type Page } from "../src/pages/tree"

const compare = (a: string, b: string) => a < b ? -1 : Number(a > b)
const action = fc.record({ type: fc.constantFrom("insert", "set", "remove"), index: fc.nat(10000), value: fc.integer() })

function disk<K extends Key, V>() {
  const pages = new Map<number, string>()
  let reads = 0, writes = 0
  const engine = tree<K, V>({ load: id => {
    reads++
    const encoded = pages.get(id)
    if (!encoded) throw new Error("Missing page")
    return JSON.parse(encoded) as Page<K, V>
  } })
  const persist = (node: Node<K, V>): Node<K, V> => {
    if (node.type === "stored") return node
    const page = node.type === "leaf" ? node : Object.freeze({ ...node, children: Object.freeze(node.children.map(persist)) })
    const id = pages.size + 1
    pages.set(id, JSON.stringify(page)); writes++
    return reference(page, id)
  }
  return { engine, persist, counts: () => ({ reads, writes }), pages }
}

function valid<K extends Key, V>(root: Node<K, V>, engine: ReturnType<typeof tree<K, V>>, top = true): void {
  const page = engine.read(root)
  expect(page.width).toBeLessThanOrEqual(engine.capacity)
  expect(page.width).toBeGreaterThanOrEqual(top ? page.type === "leaf" ? 0 : 2 : engine.minimum)
  if (page.type === "leaf") {
    expect(page.height).toBe(0)
    expect(page.count).toBe(page.entries.length)
    expect(page.width).toBe(page.entries.length)
    expect(page.last).toBe(page.entries.at(-1)?.[0])
  } else {
    expect(page.width).toBe(page.children.length)
    expect(page.count).toBe(page.children.reduce((sum, child) => sum + child.count, 0))
    expect(page.last).toBe(page.children.at(-1)!.last)
    for (const child of page.children) {
      expect(child.height).toBe(page.height - 1)
      valid(child, engine, false)
    }
  }
}

test("ranked edits match arrays across splits, merges and retained roots", () => {
  fc.assert(fc.property(fc.constantFrom(4, 5, 8, DEFAULT_CAPACITY), fc.array(action, { minLength: 100, maxLength: 300 }), (capacity, actions) => {
    const engine = tree<null, number>({ capacity })
    let root: Node<null, number> = engine.empty()
    const oracle: number[] = [], retained: { root: Node<null, number>; values: number[] }[] = []
    for (const [step, action] of actions.entries()) {
      if (action.type === "insert" || !oracle.length) {
        const index = action.index % (oracle.length + 1)
        root = engine.insert(root, index, [null, action.value]); oracle.splice(index, 0, action.value)
      } else {
        const index = action.index % oracle.length
        if (action.type === "set") { root = engine.set(root, index, [null, action.value]); oracle[index] = action.value }
        else { root = engine.remove(root, index); oracle.splice(index, 1) }
      }
      valid(root, engine)
      expect([...engine.scan(root)].map(([, value]) => value)).toEqual(oracle)
      if (oracle.length) expect(engine.get(root, action.index % oracle.length)[1]).toBe(oracle[action.index % oracle.length]!)
      if (step % 31 === 0) retained.push({ root, values: [...oracle] })
    }
    for (const snapshot of retained) expect([...engine.scan(snapshot.root)].map(([, value]) => value)).toEqual(snapshot.values)
  }), { numRuns: 150, seed: 20261020 })
})

test("keyed edits match maps while sharing the ranked balancing engine", () => {
  fc.assert(fc.property(fc.constantFrom(4, 5, 8, DEFAULT_CAPACITY), fc.array(fc.tuple(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean()), { minLength: 100, maxLength: 300 }), (capacity, actions) => {
    const engine = tree<string, number>({ capacity })
    let root: Node<string, number> = engine.empty()
    const oracle = new Map<string, number>()
    for (const [key, value, remove] of actions) {
      const position = engine.seek(root, key, compare)
      expect(position.found).toBe(oracle.has(key))
      if (remove) {
        if (position.found) root = engine.remove(root, position.index)
        oracle.delete(key)
      } else {
        root = position.found ? engine.set(root, position.index, [key, value]) : engine.insert(root, position.index, [key, value])
        oracle.set(key, value)
      }
      valid(root, engine)
      expect([...engine.scan(root)]).toEqual([...oracle].sort(([a], [b]) => compare(a, b)))
    }
  }), { numRuns: 100, seed: 20261021 })
})

test("bulk construction and complete deletion preserve occupancy at odd and even capacities", () => {
  for (const capacity of [4, 5, 8, DEFAULT_CAPACITY]) {
    const engine = tree<null, number>({ capacity })
    for (let length = 0; length <= capacity * capacity + 1; length++) {
      const input: Entry<null, number>[] = Array.from({ length }, (_, index) => [null, index])
      const root = engine.from(input)
      valid(root, engine)
      expect([...engine.scan(root)]).toEqual(input)
    }
    for (const side of ["front", "back", "middle"]) {
      let root: Node<null, number> = engine.from(Array.from({ length: 1000 }, (_, index) => [null, index] as const))
      while (root.count) {
        root = engine.remove(root, side === "front" ? 0 : side === "back" ? root.count - 1 : Math.floor(root.count / 2))
        valid(root, engine)
      }
      expect(root.type).toBe("leaf")
      expect(root.height).toBe(0)
    }
  }
})

test("stored and memory pages use the same algorithms and preserve previous disk roots", () => {
  fc.assert(fc.property(fc.array(action, { minLength: 100, maxLength: 250 }), actions => {
    const store = disk<null, number>(), engine = store.engine
    let root = store.persist(engine.from(Array.from({ length: 200 }, (_, index) => [null, index] as const)))
    const before = root, oracle = Array.from({ length: 200 }, (_, index) => index)
    for (const [step, action] of actions.entries()) {
      if (action.type === "insert" || !oracle.length) {
        const index = action.index % (oracle.length + 1)
        root = engine.insert(root, index, [null, action.value]); oracle.splice(index, 0, action.value)
      } else {
        const index = action.index % oracle.length
        if (action.type === "set") { root = engine.set(root, index, [null, action.value]); oracle[index] = action.value }
        else { root = engine.remove(root, index); oracle.splice(index, 1) }
      }
      if (step % 7 === 0) root = store.persist(root)
    }
    root = store.persist(root)
    expect([...engine.scan(root)].map(([, value]) => value)).toEqual(oracle)
    expect([...engine.scan(before)].map(([, value]) => value)).toEqual(Array.from({ length: 200 }, (_, index) => index))
    valid(root, engine)
  }), { numRuns: 75, seed: 20261022 })
})

test("point edits read and write only a path and a bounded sibling set", () => {
  for (const length of [100, 10000, 100000]) {
    const store = disk<null, number>(), engine = store.engine
    const root = store.persist(engine.from(Array.from({ length }, (_, index) => [null, index] as const)))
    for (const operation of ["get", "set", "insert", "remove"] as const) {
      const before = store.counts(), index = Math.floor(length / 2)
      const result = operation === "get" ? (expect(engine.get(root, index)[1]).toBe(index), root)
        : operation === "set" ? engine.set(root, index, [null, -1])
        : operation === "insert" ? engine.insert(root, index, [null, -1]) : engine.remove(root, index)
      store.persist(result)
      const after = store.counts()
      expect(after.reads - before.reads).toBeLessThanOrEqual(2 * (root.height + 1))
      expect(after.writes - before.writes).toBeLessThanOrEqual(operation === "get" ? 0 : 2 * (root.height + 1) + 1)
      expect([...engine.scan(root, index, index + 2)].map(([, value]) => value)).toEqual([index, index + 1])
    }
    const before = store.counts()
    expect([...engine.scan(root, length - 3)].map(([, value]) => value)).toEqual([length - 3, length - 2, length - 1])
    expect(store.counts().reads - before.reads).toBeLessThanOrEqual(root.height + 2)
  }
})

test("bounds, storage metadata and caller-owned tuples cannot silently change state", () => {
  const engine = tree<null, number>({ capacity: 4 }), input: [null, number] = [null, 1]
  const root = engine.insert(engine.empty(), 0, input)
  input[1] = 2
  expect(engine.get(root, 0)).toEqual([null, 1])
  expect(Object.isFrozen(root)).toBe(true)
  for (const capacity of [0, 3, 4.5, NaN, Infinity]) expect(() => tree({ capacity })).toThrow()
  for (const index of [-1, 0.5, 2, NaN, Infinity]) expect(() => engine.insert(root, index, [null, 3])).toThrow()
  expect(() => engine.remove(root, 1)).toThrow()
  expect(() => [...engine.scan(root, 1, 0)]).toThrow()
  const stored = reference(root, 1)
  expect(() => engine.get(stored, 0)).toThrow("unavailable")
  const wrong = tree<null, number>({ capacity: 4, load: () => engine.empty() })
  expect(() => wrong.get(stored, 0)).toThrow("metadata mismatch")
  expect(() => reference(root, 0)).toThrow()
})

test("split and join preserve balanced ranges without renumbering the suffix", () => {
  fc.assert(fc.property(fc.constantFrom(4, 5, 8, DEFAULT_CAPACITY), fc.array(fc.integer(), { minLength: 1, maxLength: 3000 }), fc.nat(), fc.nat(), (capacity, values, a, b) => {
    const engine = tree<null, number>({ capacity }), root = engine.from(values.map(value => [null, value]))
    const start = a % (values.length + 1), end = start + b % (values.length - start + 1)
    const [prefix, tail] = engine.split(root, start), [middle, suffix] = engine.split(tail, end - start)
    for (const part of [prefix, middle, suffix]) valid(part, engine)
    expect([...engine.scan(middle)].map(([, value]) => value)).toEqual(values.slice(start, end))
    const result = engine.join(prefix, suffix)
    valid(result, engine)
    expect([...engine.scan(result)].map(([, value]) => value)).toEqual([...values.slice(0, start), ...values.slice(end)])
    const restored = engine.join(engine.join(prefix, middle), suffix)
    valid(restored, engine)
    expect([...engine.scan(restored)].map(([, value]) => value)).toEqual(values)
  }), { numRuns: 200, seed: 20261023 })
})
