import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { effect } from "@clavia/tardigrade-core/effect"
import { intent } from "@clavia/tardigrade-core/intent"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import {
  cancelComponent,
  composeComponents,
  deriveComponent,
  incrementalComponent,
  legacyComponent,
  transitionProjectionOf,
  type Component,
  type ViewAlgebra
} from "./index"
import type { Event } from "@clavia/tardigrade-core/event"

interface Facts {
  readonly names: ReadonlyArray<string>
}

const facts: ViewAlgebra<Facts> = {
  empty: { names: [] },
  combine: (left, right) => ({ names: [...left.names, ...right.names] })
}

const component = (name: string, event: string): Component<Facts> => legacyComponent({
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

    expect(deriveComponent(composed, log).view).toEqual({ names: ["left", "right"] })
    expect(deriveComponent(composed, log).transitions.map((owed) => owed.key)).toEqual(["left", "right"])
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

    expect(deriveComponent(composed, log).transitions.map((owed) => owed.key)).toEqual(["right"])
    expect(observed).toEqual([{ log, keys: ["left", "right"] }])
  })

  test("reconciliation sees intents and external effects in one transition set", () => {
    const source: Component<Facts> = legacyComponent({
      name: "mixed",
      derive: () => ({
        view: facts.empty,
        transitions: [
          intent({ key: "decision", input: undefined, events: () => [] }),
          effect({ key: "work", input: undefined, act: () => Effect.succeed([]) })
        ]
      })
    })
    const observed: string[] = []
    const composed = composeComponents("mixed-root", facts, [source], {
      reconcile: (_events, transitions) => {
        observed.push(...transitions.map((transition) => transition.kind))
        return transitions.filter((transition) => transition.kind === "intent")
      }
    })

    expect(observed).toEqual([])
    expect(deriveComponent(composed, []).transitions.map((transition) => transition.key)).toEqual(["decision"])
    expect(observed).toEqual(["intent", "effect"])
  })

  test("composition refuses work a reconciler did not receive", () => {
    const source = component("source", "Ready")
    const foreign = effect({ key: "foreign", input: undefined, act: () => Effect.succeed([]) })
    const composed = composeComponents("invalid", facts, [source], {
      reconcile: () => [foreign]
    })

    expect(() => deriveComponent(composed, [{ type: "Ready" }])).toThrow(
      'component "invalid" reconciler returned work outside its transition set'
    )
  })

  test("composition refuses a transition selected more than once", () => {
    const source = component("source", "Ready")
    const composed = composeComponents("duplicate", facts, [source], {
      reconcile: (_events, transitions) => [transitions[0]!, transitions[0]!]
    })

    expect(() => deriveComponent(composed, [{ type: "Ready" }])).toThrow(
      'component "duplicate" reconciler returned transition "source" more than once'
    )
  })

  test("the empty composition derives the algebra's empty view and no work", () => {
    const composed = composeComponents("empty", facts, [])

    expect(deriveComponent(composed, [])).toEqual({ view: facts.empty, transitions: [] })
  })

  test("composition is associative for view and transition order", () => {
    const left = component("left", "Ready")
    const middle = component("middle", "Ready")
    const right = component("right", "Ready")
    const log: ReadonlyArray<Event> = [{ type: "Ready" }]
    const leftGrouped = deriveComponent(composeComponents("left-grouped", facts, [
      composeComponents("left-middle", facts, [left, middle]),
      right
    ]), log)
    const rightGrouped = deriveComponent(composeComponents("right-grouped", facts, [
      left,
      composeComponents("middle-right", facts, [middle, right])
    ]), log)

    expect(leftGrouped.view).toEqual(rightGrouped.view)
    expect(leftGrouped.transitions.map((owed) => owed.key)).toEqual(
      rightGrouped.transitions.map((owed) => owed.key)
    )
  })

  test("composition preserves cancellation projections in component order", () => {
    const cancellable = (name: string): Component<Facts> => legacyComponent({
      name,
      derive: () => ({ view: facts.empty, transitions: [] }),
      cancel: () => [intent({ key: `cancel:${name}`, input: undefined, events: () => [] })]
    })
    const composed = composeComponents("cancellable", facts, [cancellable("left"), cancellable("right")])

    expect(cancelComponent(composed, [], {
      request: "x1",
      invocation: { method: "work", id: "w1", epoch: 2 },
      cause: "requested"
    }).map((transition) => transition.key)).toEqual(["cancel:left", "cancel:right"])
  })

  test("the component exposes its transition projection", () => {
    const source = component("ready", "Ready")
    const log: ReadonlyArray<Event> = [{ type: "Ready" }]

    expect(replayProjection(transitionProjectionOf(source), log).map((owed) => owed.key)).toEqual(
      deriveComponent(source, log).transitions.map((owed) => owed.key)
    )
  })

  test("composition preserves incremental child projections", () => {
    const member = (name: string) => incrementalComponent({
      name,
      initial: () => false,
      step: (ready: boolean, event: Event) => ready || event.type === "Ready",
      output: (ready: boolean) => ({
        view: { names: ready ? [name] : [] },
        transitions: ready ? [intent({ key: name, input: undefined, events: () => [] })] : []
      })
    })
    const composed = composeComponents("incremental", facts, [member("left"), member("right")])
    const projection = transitionProjectionOf(composed)
    const state = projection.step(projection.initial(), { type: "Ready" })

    expect(composed.machine).toBeDefined()
    expect(projection.output(state).map((transition) => transition.key)).toEqual(["left", "right"])
    expect(deriveComponent(composed, [{ type: "Ready" }]).view).toEqual({ names: ["left", "right"] })
  })

  test("composition reuses branches whose child state identities are stable", () => {
    const derivations = new Map<string, number>()
    let combinations = 0
    const cachedFacts: ViewAlgebra<Facts> = {
      empty: facts.empty,
      combine: (left, right) => {
        combinations += 1
        return facts.combine(left, right)
      }
    }
    const member = (name: string, eventType: string) => incrementalComponent({
      name,
      initial: () => false,
      step: (ready: boolean, event: Event) => ready || event.type === eventType,
      output: (ready: boolean) => {
        derivations.set(name, (derivations.get(name) ?? 0) + 1)
        return {
          view: { names: ready ? [name] : [] },
          transitions: ready ? [intent({ key: name, input: undefined, events: () => [] })] : []
        }
      }
    })
    const composed = composeComponents("cached", cachedFacts, [
      member("left", "LeftReady"),
      member("left-sibling", "LeftSiblingReady"),
      member("right", "RightReady"),
      member("right-sibling", "RightSiblingReady")
    ])
    const projection = composed.machine
    const initial = projection.initial()
    const initialValue = projection.output(initial)
    const ignored = projection.step(initial, { type: "Ignored" })

    expect(ignored).toBe(initial)
    expect(projection.output(ignored)).toBe(initialValue)
    expect(derivations).toEqual(new Map([
      ["left", 1],
      ["left-sibling", 1],
      ["right", 1],
      ["right-sibling", 1]
    ]))
    expect(combinations).toBe(3)

    const changed = projection.step(ignored, { type: "LeftReady" })

    expect(changed).not.toBe(ignored)
    expect(projection.output(changed).view).toEqual({ names: ["left"] })
    expect(derivations).toEqual(new Map([
      ["left", 2],
      ["left-sibling", 1],
      ["right", 1],
      ["right-sibling", 1]
    ]))
    expect(combinations).toBe(5)
  })

  test("cached composition passes child state to cancellation projections", () => {
    const child = incrementalComponent({
      name: "cancellable",
      initial: () => 0,
      step: (count: number, event: Event) => event.type === "Observed" ? count + 1 : count,
      output: () => ({ view: facts.empty, transitions: [] }),
      cancelState: (count: number) => [intent({ key: `cancel:${count}`, input: undefined, events: () => [] })]
    })
    const composed = composeComponents("cached-cancellation", facts, [child])
    const projection = composed.machine
    const state = projection.step(projection.initial(), { type: "Observed" })

    expect(projection.cancel?.(state, {
      request: "x1",
      invocation: { method: "work", id: "w1", epoch: 0 },
      cause: "requested"
    }).map((transition) => transition.key)).toEqual(["cancel:1"])
  })

  test("composition refuses colliding key fragments", () => {
    const keyed = (name: string): Component<Facts> => legacyComponent({
      name,
      keys: { prefixes: ["x:"], keyOf: () => undefined },
      derive: () => ({ view: facts.empty, transitions: [] })
    })

    expect(() => composeComponents("collision", facts, [keyed("left"), keyed("right")])).toThrow(
      'key prefix "x:" claimed by fragments 0 and 1'
    )
  })

})
