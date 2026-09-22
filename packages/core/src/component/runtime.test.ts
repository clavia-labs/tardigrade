import { expect, expectTypeOf, test } from "bun:test"
import { component } from "./machine"
import type { Component, ComponentView } from "./component"
import { machineOf, registerComponent } from "./runtime"
import * as publicComponents from "./index"

const counter = () => component({
  name: "counter", initial: () => 0, step: (state) => state + 1,
  output: (state) => ({ view: { count: state }, transitions: [] })
})

test("component declarations expose no runtime machine or public accessors", () => {
  const child = counter()
  expect(child).not.toHaveProperty("machine")
  expect(child).not.toHaveProperty("initial")
  expect(child).not.toHaveProperty("step")
  expectTypeOf<"machine" extends keyof typeof child ? true : false>().toEqualTypeOf<false>()
  expectTypeOf<ComponentView<typeof child>>().toEqualTypeOf<{ count: number }>()
  expect(publicComponents).not.toHaveProperty("machineOf")
  expect(publicComponents).not.toHaveProperty("registerComponent")
  expect(publicComponents).not.toHaveProperty("transitionProjectionOf")
  expect(publicComponents).not.toHaveProperty("createMachine")
})

test("spreads retain registration without exposing the machine", () => {
  const child = counter()
  const copy = { ...child, label: "copied" }
  expect(machineOf(copy)).toBe(machineOf(child))
  expect(copy.label).toBe("copied")
  expect(copy).not.toHaveProperty("machine")
  const machine = machineOf(copy)
  expect(machine.output(machine.step(machine.initial(), { type: "Incremented" })).view).toEqual({ count: 1 })
})

test("registering a decorated machine leaves the original declaration intact", () => {
  const original = counter()
  const machine = machineOf(original)
  const decorated = registerComponent(original, { ...machine, output: () => ({ view: 99, transitions: [] }) })
  expect(machineOf(original)).toBe(machine)
  expect(machineOf(decorated).output(machineOf(decorated).initial()).view).toBe(99)
  expect(machine.output(machine.initial()).view).toEqual({ count: 0 })
})

test("unregistered declarations fail at the internal boundary", () => {
  expect(() => machineOf({ name: "forged" } as Component<unknown>)).toThrow('component "forged" is not registered')
})

test("package exports reject direct imports of component runtime internals", () => {
  expect(() => Bun.resolveSync("@clavia/tardigrade-core/component/runtime", import.meta.dir)).toThrow()
  expect(() => Bun.resolveSync("@clavia/tardigrade-core/component/composition/parent", import.meta.dir)).toThrow()
})
