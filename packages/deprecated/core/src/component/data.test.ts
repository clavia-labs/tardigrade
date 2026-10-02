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

test("views that share accepted objects still reject behavior and accessors they add", () => {
  const accepted = new WeakSet<object>()
  const message = { role: "user", parts: [{ text: "hello" }] }
  validateView({ transcript: [message] }, accepted)
  expect(accepted.has(message)).toBe(true)
  expect(() => validateView({ transcript: [message, { role: "tool", run: () => 1 }] }, accepted)).toThrow(
    "view.transcript.1.run contains executable behavior"
  )
  const transcript = [message]
  Object.defineProperty(transcript, 1, { get: () => message, enumerable: true })
  expect(() => validateView({ transcript }, accepted)).toThrow("view.transcript.1 contains an accessor")
})

test("a rejected view records nothing it reached", () => {
  const accepted = new WeakSet<object>()
  const inner = { text: "hello" }
  const rejected = { inner, run: () => 1 }
  expect(() => validateView({ item: rejected }, accepted)).toThrow("executable")
  expect(accepted.has(inner)).toBe(false)
  expect(() => validateView({ again: rejected }, accepted)).toThrow("view.again.run contains executable behavior")
})

test("a component folding a shared transcript accepts and rejects what a fresh walk does", () => {
  // Every third entry carries a function and every fifth an accessor; earlier entries are shared by reference.
  const entry = (i: number): unknown => {
    if (i % 3 === 1) return { at: i, run: () => i }
    if (i % 5 === 2) return Object.defineProperty({ at: i }, "text", { get: () => "", enumerable: true })
    return { at: i, parts: [{ text: `m${i}` }], index: new Map([[i, { i }]]) }
  }
  const machine = machineOf(
    component({
      name: "transcript",
      initial: (): ReadonlyArray<unknown> => [],
      step: (state, event) => [...state, entry(Number(event.at))],
      output: (state) => ({ view: { transcript: state, count: state.length }, transitions: [] })
    })
  )
  const outcome = (read: () => unknown): string => {
    try {
      read()
      return "accepted"
    } catch (error) {
      return String(error)
    }
  }
  let state = machine.initial()
  let transcript: ReadonlyArray<unknown> = []
  for (let at = 0; at < 200; at++) {
    const next = machine.step(state, { type: "Appended", at })
    const copy = [...transcript, entry(at)]
    const fresh = outcome(() => validateView({ transcript: copy, count: copy.length }))
    expect(outcome(() => machine.output(next))).toBe(fresh)
    if (fresh === "accepted") [state, transcript] = [next, copy]
  }
})
