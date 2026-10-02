import { bindTransitionContext } from "../../transition/transition"
import { eventAt } from "../../event"
import { expect, expectTypeOf, test } from "bun:test"
import { component } from "../machine"
import { machineOf } from "../runtime"
import { composeComponents } from "./siblings"
import { replayProjection } from "../../projection/projection"
import type { ComponentView } from "../component"

const counter = (name: string) =>
  component({
    name,
    initial: () => 0,
    step: (state, event) => state + (event.type === name ? 1 : 0),
    output: (state) => ({ view: { consumed: state }, transitions: [] })
  })
const sum = {
  empty: { consumed: 0 },
  combine: (a: { consumed: number }, b: { consumed: number }) => ({ consumed: a.consumed + b.consumed })
}

test("parents explicitly choose their public view", () => {
  const parent = component({
    name: "parent",
    children: counter("child"),
    initial: () => undefined,
    step: (state) => state,
    output: (_state, child) => ({
      view: { remaining: 10 - child.output().view.consumed },
      transitions: child.output().transitions
    })
  })
  expectTypeOf<ComponentView<typeof parent>>().toEqualTypeOf<{ remaining: number }>()
  expect(replayProjection(machineOf(parent), [{ type: "child" }]).view).toEqual({ remaining: 9 })
})

test("sibling views merge with the selected algebra and its empty value", () => {
  const a = counter("a"),
    b = counter("b"),
    c = counter("c")
  const flat = composeComponents("flat", sum, [a, b, c])
  const nested = composeComponents("nested", sum, [composeComponents("ab", sum, [a, b]), c])
  const empty = composeComponents("empty", sum, [])
  const log = [{ type: "a" }, { type: "c" }, { type: "b" }, { type: "a" }]
  for (let n = 0; n <= log.length; n++) {
    expect(replayProjection(machineOf(nested), log.slice(0, n))).toEqual(
      replayProjection(machineOf(flat), log.slice(0, n))
    )
  }
  expect(replayProjection(machineOf(empty), []).view).toEqual({ consumed: 0 })
})

test("reconciliation receives the combined public view", () => {
  const worker = component({
    name: "worker",
    initial: () => 0,
    step: (state) => state + 1,
    output: (state) => ({
      view: { consumed: state },
      transitions: [
        bindTransitionContext(eventAt({ type: "Tick" }, 1), "worker").intent("record", { type: "Recorded" })
      ]
    })
  })
  let observed: unknown
  const combined = composeComponents("combined", sum, [worker], {
    reconcile: (_log, transitions, view) => {
      observed = view
      return transitions
    }
  })
  expectTypeOf<ComponentView<typeof combined>>().toEqualTypeOf<{ consumed: number }>()
  expect(replayProjection(machineOf(combined), [{ type: "Tick" }]).view).toEqual({ consumed: 1 })
  expect(observed).toEqual({ consumed: 1 })
})

test("state-dependent interactions remain separate from the public view", () => {
  const child = component({
    name: "child",
    initial: () => 0,
    step: (state) => state + 1,
    output: (state) => ({ view: { count: state }, interactions: { read: () => state }, transitions: [] })
  })
  const combined = composeComponents(
    "combined",
    { empty: { count: 0 }, combine: (a: { count: number }, b: { count: number }) => ({ count: a.count + b.count }) },
    [child],
    {
      interactions: ([child]) => ({ read: () => child?.read() })
    }
  )
  const output = replayProjection(machineOf(combined), [{ type: "Tick" }])
  expect(output.view).toEqual({ count: 1 })
  expect(output.interactions?.read()).toBe(1)
  expect(output.view).not.toHaveProperty("read")
})

test("sibling interactions require explicit forwarding for every arity", () => {
  const leaf = (name: string) =>
    component({
      name,
      initial: () => 0,
      step: (state) => state,
      output: (state) => ({ view: { consumed: state }, interactions: { read: () => state }, transitions: [] })
    })
  const a = leaf("a"),
    b = leaf("b")
  for (const children of [[], [a], [a, b]]) {
    expect(replayProjection(machineOf(composeComponents("parent", sum, children)), []).interactions).toBeUndefined()
  }
})
