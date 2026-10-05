import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-deprecated-core/event"
import { materializeProjection, replayProjection, replayState, type Projection } from "./projection"
import { machineOf } from "../component/runtime"
import { component, composeComponents, type ViewAlgebra } from "../component/index"

const counter: Projection<number, number> = {
  initial: () => 0,
  step: (state, event) => event.type === "Counted" ? state + 1 : state,
  output: (state) => state * 10
}

const counted = (count: number): ReadonlyArray<Event> => Array.from({ length: count }, () => ({ type: "Counted" }))

const sum: ViewAlgebra<number> = { empty: 0, combine: (left, right) => left + right }

// counting builds one child per event type E0..E7 whose output counts its own derivations.
const counting = (reads: { count: number }) => Array.from({ length: 8 }, (_, index) => component({
  name: `m${index}`,
  initial: () => 0,
  step: (state, event) => event.type === `E${index}` ? state + 1 : state,
  output: (state) => {
    reads.count++
    return { view: state * (index + 1), transitions: [] }
  }
}))

describe("lazy outputs", () => {
  test("materialization derives output on read, not per event", () => {
    let reads = 0
    const materialized = materializeProjection({ ...counter, output: (state: number) => { reads++; return counter.output(state) } })
    const state = replayState(materialized, counted(1_000))

    expect(reads).toBe(0)
    expect(materialized.output(state)).toBe(replayProjection(counter, counted(1_000)))
    expect(materialized.output(state)).toBe(10_000)
    expect(reads).toBe(1)
  })

  test("an output that throws throws at its first read, not at the step", () => {
    const materialized = materializeProjection({ ...counter, output: (): number => { throw new Error("unreadable") } })
    const state = replayState(materialized, counted(3))

    expect(() => materialized.output(state)).toThrow("unreadable")
  })

  test("composed replay derives each child output once and equals the eager result", () => {
    const reads = { count: 0 }
    const machine = machineOf(composeComponents("lazy", sum, counting(reads)))
    const log = Array.from({ length: 4_000 }, (_, index): Event => ({ type: `E${index % 8}` }))

    const output = machine.output(replayState(machine, log))

    expect(output.view).toBe(500 * (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8))
    expect(reads.count).toBe(8)
  })

  test("reads between steps derive only changed leaves and match a fresh replay", () => {
    const reads = { count: 0 }
    const machine = machineOf(composeComponents("partial", sum, counting(reads)))
    const log = Array.from({ length: 64 }, (_, index): Event => ({ type: `E${(index * 3) % 8}` }))
    const expected = log.map((_, index) => replayProjection(machine, log.slice(0, index + 1)).view)

    let state = machine.initial()
    machine.output(state)
    reads.count = 0
    const observed = log.map((event) => {
      state = machine.step(state, event)
      return machine.output(state).view
    })

    expect(observed).toEqual(expected)
    expect(reads.count).toBe(log.length)
  })
})
