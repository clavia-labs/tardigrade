import { expect, test } from "bun:test"
import { Chunk, HashMap, HashSet } from "effect"
import { component } from "./machine"
import { machineOf } from "./runtime"
import { legacyComponent } from "./legacy"
import { validateView } from "./data"

const read = (view: unknown) => {
  const machine = machineOf(
    component({
      name: "data",
      initial: () => view,
      step: (state) => state,
      output: (state) => ({ view: state, transitions: [] })
    })
  )
  return machine.output(machine.initial()).view
}

test("views retain non-JSON data and persistent collections", () => {
  const view = {
    at: new Date(0),
    count: 1n,
    missing: undefined,
    key: Symbol("key"),
    map: new Map([["a", { count: 1 }]]),
    set: new Set([2]),
    persistent: HashMap.make(["a", HashSet.make(1, 2)]),
    chunk: Chunk.make(1, 2)
  }
  expect(read(view)).toBe(view)
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  expect(read(cyclic)).toBe(cyclic)
})

test("views reject executable values at nested and collection boundaries", () => {
  for (const view of [
    () => 1,
    { nested: [{ run: () => 1 }] },
    new Map([["run", () => 1]]),
    new Set([() => 1]),
    HashMap.make(["run", () => 1]),
    HashSet.make(() => 1),
    Chunk.make(() => 1),
    { [Symbol("run")]: () => 1 },
    Promise.resolve(1)
  ]) {
    expect(() => read(view)).toThrow()
  }
})

test("views reject accessors and domain methods without invoking them", () => {
  let invoked = false
  expect(() =>
    validateView({
      get value() {
        invoked = true
        return 1
      }
    })
  ).toThrow("accessor")
  class Capability {
    run() {
      invoked = true
    }
  }
  expect(() => validateView(new Capability())).toThrow("executable")
  expect(invoked).toBe(false)
  class Data {
    constructor(readonly value: number) {}
  }
  expect(() => validateView(new Data(1))).not.toThrow()
})

test("legacy components enforce the same data boundary", () => {
  const machine = machineOf(
    legacyComponent({ name: "legacy", derive: () => ({ view: { run: () => 1 }, transitions: [] }) })
  )
  expect(() => machine.output(machine.initial())).toThrow("executable")
})

test("state-bound interactions are callable outside the data view", () => {
  const machine = machineOf(
    component({
      name: "interactions",
      initial: () => 2,
      step: (state) => state + 1,
      output: (state) => ({ view: { count: state }, transitions: [], interactions: { read: () => state } })
    })
  )
  const output = machine.output(machine.initial())
  expect(output.view).toEqual({ count: 2 })
  expect(output.interactions?.read()).toBe(2)
})


test("native data containers cannot carry application callbacks or accessors", () => {
  for (const container of [new Date(0), new Map(), new Set()]) {
    expect(() => read(Object.assign(container, { run: () => 1 }))).toThrow("executable")
  }
  let invoked = false
  const map = new Map([[1, 2]])
  Object.defineProperty(map, Symbol.iterator, { get() { invoked = true; return () => [] } })
  expect(() => read(map)).toThrow("accessor")
  expect(invoked).toBe(false)
})


test("each new snapshot validates its view before exposing it", () => {
  const machine = machineOf(component({ name: "changing", initial: () => false, step: () => true,
    output: invalid => ({ view: invalid ? { run: () => 1 } : { count: 1 }, transitions: [] }) }))
  const initial = machine.initial()
  expect(machine.output(initial)).toBe(machine.output(initial))
  const changed = machine.step(initial, { type: "Changed" })
  expect(() => machine.output(changed)).toThrow("executable")
})
