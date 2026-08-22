import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { transition } from "./actor"
import { actorOf, composeComponents, reactorOf, type Component, type ComponentRuntime, type ViewAlgebra } from "./component"
import type { Event } from "./event"

interface Facts {
  readonly names: ReadonlyArray<string>
}

const facts: ViewAlgebra<Facts> = {
  empty: { names: [] },
  combine: (left, right) => ({ names: [...left.names, ...right.names] })
}

const component = (name: string, event: string): Component<Facts> => ({
  name,
  derive: (log) => ({
    view: { names: log.some((entry) => entry.type === event) ? [name] : [] },
    transitions: log.some((entry) => entry.type === event)
      ? [transition({ key: name, input: name, act: () => Effect.succeed([]) })]
      : []
  })
})

describe("components", () => {
  test("composition combines views and concatenates transitions in component order", () => {
    const left = component("left", "Ready")
    const right = component("right", "Ready")
    const log: ReadonlyArray<Event> = [{ type: "Ready" }]
    const composed = composeComponents("both", facts, [left, right])

    expect(composed.derive(log).view).toEqual({ names: ["left", "right"] })
    expect(composed.derive(log).transitions.map((owed) => owed.key)).toEqual(["left", "right"])
  })

  test("the empty composition derives the algebra's empty view and no work", () => {
    const composed = composeComponents("empty", facts, [])

    expect(composed.derive([])).toEqual({ view: facts.empty, transitions: [] })
  })

  test("composition is associative for view and transition order", () => {
    const left = component("left", "Ready")
    const middle = component("middle", "Ready")
    const right = component("right", "Ready")
    const log: ReadonlyArray<Event> = [{ type: "Ready" }]
    const leftGrouped = composeComponents("left-grouped", facts, [
      composeComponents("left-middle", facts, [left, middle]),
      right
    ]).derive(log)
    const rightGrouped = composeComponents("right-grouped", facts, [
      left,
      composeComponents("middle-right", facts, [middle, right])
    ]).derive(log)

    expect(leftGrouped.view).toEqual(rightGrouped.view)
    expect(leftGrouped.transitions.map((owed) => owed.key)).toEqual(
      rightGrouped.transitions.map((owed) => owed.key)
    )
  })

  test("the reactor adapter preserves the transition projection", () => {
    const source = component("ready", "Ready")
    const log: ReadonlyArray<Event> = [{ type: "Ready" }]

    expect(reactorOf(source)(log).map((owed) => owed.key)).toEqual(
      source.derive(log).transitions.map((owed) => owed.key)
    )
  })

  test("composition refuses colliding key fragments", () => {
    const keyed = (name: string): Component<Facts> => ({
      name,
      keys: { prefixes: ["x:"], keyOf: () => undefined },
      derive: () => ({ view: facts.empty, transitions: [] })
    })

    expect(() => composeComponents("collision", facts, [keyed("left"), keyed("right")])).toThrow(
      'key prefix "x:" claimed by fragments 0 and 1'
    )
  })

  test("actorOf gives the composed view to its runtime and component work to reconciliation", () => {
    const seen: Facts[] = []
    const runtime: ComponentRuntime<Facts> = {
      name: "facts",
      algebra: facts,
      keys: [],
      reactors: (viewOf) => [
        (log) => {
          seen.push(viewOf(log))
          return []
        }
      ]
    }
    const assembled = actorOf(runtime, [component("left", "Ready"), component("right", "Ready")])
    const log: ReadonlyArray<Event> = [{ type: "Ready" }]

    expect(assembled.reactors).toHaveLength(2)
    expect(assembled.reactors.flatMap((reactor) => reactor(log)).map((owed) => owed.key)).toEqual(["left", "right"])
    expect(seen).toEqual([{ names: ["left", "right"] }])
  })
})
