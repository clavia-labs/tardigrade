import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { intent, effect } from "./actor"
import { actor, composeComponents, reactorOf, type Component, type ViewAlgebra } from "./component"
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
      ? [effect({ key: name, input: name, act: () => Effect.succeed([]) })]
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

  test("composition reconciles the complete transition set", () => {
    const left = component("left", "Ready")
    const right = component("right", "Ready")
    const log: ReadonlyArray<Event> = [{ type: "Ready" }]
    const observed: Array<{ log: ReadonlyArray<Event>; keys: ReadonlyArray<string> }> = []
    const composed = composeComponents("selected", facts, [left, right], {
      reconcile: (events, transitions) => {
        observed.push({ log: events, keys: transitions.map((transition) => transition.key) })
        return transitions.filter((transition) => transition.key === "right")
      }
    })

    expect(composed.derive(log).transitions.map((owed) => owed.key)).toEqual(["right"])
    expect(observed).toEqual([{ log, keys: ["left", "right"] }])
  })

  test("reconciliation sees intents and external effects in one transition set", () => {
    const source: Component<Facts> = {
      name: "mixed",
      derive: () => ({
        view: facts.empty,
        transitions: [
          intent({ key: "decision", input: undefined, events: () => [] }),
          effect({ key: "work", input: undefined, act: () => Effect.succeed([]) })
        ]
      })
    }
    const observed: string[] = []
    const composed = composeComponents("mixed-root", facts, [source], {
      reconcile: (_events, transitions) => {
        observed.push(...transitions.map((transition) => transition.kind))
        return transitions.filter((transition) => transition.kind === "intent")
      }
    })

    expect(observed).toEqual([])
    expect(composed.derive([]).transitions.map((transition) => transition.key)).toEqual(["decision"])
    expect(observed).toEqual(["intent", "effect"])
  })

  test("composition refuses work a reconciler did not receive", () => {
    const source = component("source", "Ready")
    const foreign = effect({ key: "foreign", input: undefined, act: () => Effect.succeed([]) })
    const composed = composeComponents("invalid", facts, [source], {
      reconcile: () => [foreign]
    })

    expect(() => composed.derive([{ type: "Ready" }])).toThrow(
      'component "invalid" reconciler returned work outside its transition set'
    )
  })

  test("composition refuses a transition selected more than once", () => {
    const source = component("source", "Ready")
    const composed = composeComponents("duplicate", facts, [source], {
      reconcile: (_events, transitions) => [transitions[0]!, transitions[0]!]
    })

    expect(() => composed.derive([{ type: "Ready" }])).toThrow(
      'component "duplicate" reconciler returned transition "source" more than once'
    )
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

  test("actor adapts root components to reactors in component order", () => {
    const assembled = actor(component("left", "Ready"), component("right", "Ready"))
    const log: ReadonlyArray<Event> = [{ type: "Ready" }]

    expect(assembled.reactors).toHaveLength(2)
    expect(assembled.reactors.flatMap((reactor) => reactor(log)).map((owed) => owed.key)).toEqual(["left", "right"])
  })
})
