import { machineOf } from "../runtime"
import { replayProjection, replayState } from "@clavia/tardigrade-core/projection"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { actor } from "../../actor"
import type { Event } from "../../event"
import { enabled } from "../../runtime"
import type { TransitionContext } from "../../transition/transition"
import { component, composeComponents, independentTransitions, type Component, type TransitionReconciler, type ViewAlgebra } from "../index"

// PublicTrace compares views and proposal declarations for these fixtures; it does not assert equivalence of arbitrary effect programs.
type PublicTrace<V> = {
  readonly view: V
  readonly proposals: ReadonlyArray<{ readonly key: string; readonly kind: string; readonly input: unknown }>
}

interface Claim {
  readonly id: string
  readonly cost: number
  readonly permission: "read" | "write"
  readonly kind: "intent" | "effect"
}

const algebra: ViewAlgebra<ReadonlyArray<string>> = {
  empty: [],
  combine: (left, right) => [...left, ...right]
}

const counter = (name: string, count = 0) => component({
  name,
  initial: () => ({ count, context: undefined as TransitionContext | undefined }),
  step: (state, event, context) => event.type === name ? { count: state.count + 1, context } : state,
  output: (state) => ({
    view: state.count,
    transitions: state.context === undefined ? [] : [state.context.intent("work", { type: "Worked", count: state.count })]
  })
})
const mapView = <A, B>(name: string, child: Component<A>, project: (value: A) => B) =>
  component({ name, children: child, initial: () => undefined, step: state => state,
    output: (_state, child) => ({ ...child.output(), view: project(child.output().view as A) }) })
const sums: ViewAlgebra<number> = { empty: 0, combine: (a, b) => a + b }

const histories = fc.array(fc.constantFrom("a", "b", "c", "Ignored"), { maxLength: 30 })
const events = (types: ReadonlyArray<string>): ReadonlyArray<Event> => types.map((type) => ({ type }))

const leaf = (claim: Claim): Component<ReadonlyArray<string>> => ({
  ...component({
    name: claim.id,
    initial: (): TransitionContext | undefined => undefined,
    step: (state, event, context) => event.type === "Ready" && (event.target === undefined || event.target === claim.id) ? context : state,
    output: (context) => ({
      view: context === undefined ? [] : [claim.id],
      transitions: context === undefined ? [] : [claim.kind === "intent"
        ? context.intent("work", { type: "Done", ...claim })
        : context.effect("work", {
            input: claim,
            act: (input) => Effect.succeed([{ type: "Done", id: input.id }])
          })]
    })
  }),
  keys: {
    prefixes: [`${claim.id}:`],
    keyOf: (event) => event.type === "Done" && event.id === claim.id ? `${claim.id}:done` : undefined
  }
})

const merge = (name: string, children: ReadonlyArray<Component<ReadonlyArray<string>>>) =>
  composeComponents(name, algebra, children)

const regroup = (
  leaves: ReadonlyArray<Component<ReadonlyArray<string>>>,
  choices: ReadonlyArray<number>
): Component<ReadonlyArray<string>> => {
  if (leaves.length === 0) return merge("nested-empty", [])
  const nodes = [...leaves]
  let step = 0
  while (nodes.length > 1) {
    const choice = choices[step % Math.max(choices.length, 1)] ?? 0
    const index = choice % (nodes.length - 1)
    nodes.splice(index, 2, merge(`nested-${step}`, [nodes[index]!, nodes[index + 1]!]))
    step++
  }
  return nodes[0]!
}

const wrap = (
  name: string,
  child: Component<ReadonlyArray<string>>,
  reconcile: TransitionReconciler
) => composeComponents(name, algebra, [child], { reconcile })

const publicTrace = <V>(child: Component<V>, log: ReadonlyArray<Event>): PublicTrace<V> => {
  const state = replayState(machineOf(child), log)
  const output = machineOf(child).output(state)
  return {
    view: machineOf(child).output(state).view,
    proposals: output.transitions.map(({ key, kind, input }) => ({ key, kind, input }))
  }
}

const claimOf = (transition: { readonly input: unknown }): Claim => transition.input as Claim

const permissions: TransitionReconciler = (log, transitions) => {
  const granted = new Set<string>()
  for (const event of log) {
    if (event.type === "Grant") granted.add(String(event.permission))
    if (event.type === "Revoke") granted.delete(String(event.permission))
  }
  return transitions.filter((transition) => granted.has(claimOf(transition).permission))
}

const capacity = (limit: number): TransitionReconciler => (_log, transitions) => {
  let remaining = limit
  return transitions.filter((transition) => {
    const cost = claimOf(transition).cost
    if (cost > remaining) return false
    remaining -= cost
    return true
  })
}

const composePolicies = (outer: TransitionReconciler, inner: TransitionReconciler): TransitionReconciler =>
  (log, transitions, view) => outer(log, inner(log, transitions, view), view)

const claims = fc.array(fc.record({
  cost: fc.integer({ min: 1, max: 10 }),
  permission: fc.constantFrom("read", "write"),
  kind: fc.constantFrom("intent", "effect")
}), { maxLength: 12 }).map((entries): ReadonlyArray<Claim> => entries.map((entry, index) => ({
  ...entry, id: `leaf-${index}`
})))

const logs = fc.array(fc.oneof(
  fc.constant({ type: "Ready" }),
  fc.nat(11).map((index) => ({ type: "Ready", target: `leaf-${index}` })),
  fc.record({ type: fc.constantFrom("Grant", "Revoke"), permission: fc.constantFrom("read", "write") })
), { maxLength: 15 })

const ready: ReadonlyArray<Event> = [{ type: "Ready" }, { type: "Grant", permission: "read" }]

describe("sibling composition laws (Seven Sketches, sections 4.4.3 and 5.4.2)", () => {
  test("sum views have an explicit empty unit", () => {
    fc.assert(fc.property(histories, (types) => {
      const child = counter("a")
      const empty = composeComponents("empty", sums, [])
      const left = composeComponents("left", sums, [empty, child])
      const right = composeComponents("right", sums, [child, empty])
      const log = events(types)
      const expected = publicTrace(child, log)
      expect(publicTrace(left, log)).toEqual(expected)
      expect(publicTrace(right, log)).toEqual(expected)
    }))
  })

  test("empty is a left and right identity", () => {
    fc.assert(fc.property(claims, logs, (specs, log) => {
      const child = merge("assembly", specs.map(leaf))
      const empty = merge("empty", [])
      expect(publicTrace(merge("left", [empty, child]), log)).toEqual(publicTrace(child, log))
      expect(publicTrace(merge("right", [child, empty]), log)).toEqual(publicTrace(child, log))
    }))
  })

  test("every grouping agrees with the flat composition", () => {
    fc.assert(fc.property(claims, logs, fc.array(fc.nat(), { maxLength: 20 }), (specs, log, choices) => {
      const leaves = specs.map(leaf)
      const flat = merge("flat", leaves)
      const nested = regroup(leaves, choices)
      const separate = leaves.map((child) => publicTrace(child, log))
      const expected = {
        view: separate.flatMap((output) => output.view),
        proposals: separate.flatMap((output) => output.proposals)
      }
      expect(publicTrace(flat, log)).toEqual(expected)
      expect(publicTrace(nested, log)).toEqual(expected)
      const prefixes = specs.map((claim) => `${claim.id}:`)
      expect(flat.keys?.prefixes ?? []).toEqual(prefixes)
      expect(nested.keys?.prefixes ?? []).toEqual(prefixes)
      for (const claim of specs) {
        const event = { type: "Done", id: claim.id }
        expect(flat.keys?.keyOf(event)).toBe(`${claim.id}:done`)
        expect(nested.keys?.keyOf(event)).toBe(`${claim.id}:done`)
      }
      for (const event of log) expect(nested.keys?.keyOf(event)).toBe(flat.keys?.keyOf(event))
      const flatActor = actor({ name: "flat-actor", methods: {}, components: [flat] })
      const nestedActor = actor({ name: "nested-actor", methods: {}, components: [nested] })
      const declarations = (transitions: ReturnType<typeof enabled>) => transitions.map(({ key, kind, input }) => ({ key, kind, input }))
      expect(declarations(enabled(nestedActor, log))).toEqual(declarations(enabled(flatActor, log)))
    }), { numRuns: 500 })
  })

  test("sibling order is observable, so commutativity is not a law", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10 }), (cost) => {
      const a = leaf({ id: "a", cost, permission: "read", kind: "intent" })
      const b = leaf({ id: "b", cost, permission: "read", kind: "effect" })
      expect(publicTrace(merge("ab", [a, b]), ready)).not.toEqual(publicTrace(merge("ba", [b, a]), ready))
    }))
  })
})

describe("selection parent laws (Seven Sketches, sections 3.2 and 6.5)", () => {
  test("an explicit identity projection preserves views at every prefix", () => {
    fc.assert(fc.property(histories, (types) => {
      const child = counter("a")
      const parent = mapView("identity", child, (value) => value)
      const log = events(types)
      for (let length = 0; length <= log.length; length++) {
        const prefix = log.slice(0, length)
        expect(publicTrace(parent, prefix)).toEqual(publicTrace(child, prefix))
      }
    }))
  })

  test("typed view maps compose inside out", () => {
    fc.assert(fc.property(histories, fc.integer({ min: 0, max: 30 }), (types, limit) => {
      const child = counter("a")
      const f = (used: number) => ({ used, remaining: limit - used })
      const g = (state: ReturnType<typeof f>) => ({ exhausted: state.remaining <= 0 })
      const nested = mapView("outer", mapView("inner", child, f), g)
      const direct = mapView("direct", child, (value) => g(f(value)))
      const log = events(types)
      for (let length = 0; length <= log.length; length++) {
        const prefix = log.slice(0, length)
        expect(publicTrace(nested, prefix)).toEqual(publicTrace(direct, prefix))
      }
    }))
  })

  test("a parent cannot suppress proposals from another root sibling", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10 }), (cost) => {
      const inside = leaf({ id: "inside", cost, permission: "read", kind: "intent" })
      const outside = leaf({ id: "outside", cost, permission: "read", kind: "intent" })
      const parent = wrap("deny", inside, () => [])
      const root = actor({ name: "root", methods: {}, components: [parent, outside] })
      expect(enabled(root, ready).map(claimOf).map((claim) => claim.id)).toEqual(["outside"])
    }))
  })

  test("a pass-through parent preserves the child output trace", () => {
    fc.assert(fc.property(claims, logs, (specs, log) => {
      const child = merge("assembly", specs.map(leaf))
      expect(publicTrace(wrap("identity", child, independentTransitions), log)).toEqual(publicTrace(child, log))
    }))
  })

  test("nested selection agrees with inside-out policy composition", () => {
    fc.assert(fc.property(claims, logs, fc.nat(30), (specs, log, limit) => {
      const child = merge("assembly", specs.map(leaf))
      const checked: TransitionReconciler = (history, proposals, view) => {
        const expected = permissions(history, replayProjection(machineOf(child), history).transitions, view)
        expect(proposals.map(claimOf)).toEqual(expected.map(claimOf))
        return capacity(limit)(history, proposals, view)
      }
      const nested = wrap("budget", wrap("permissions", child, permissions), checked)
      const combined = wrap("combined", child, composePolicies(capacity(limit), permissions))
      expect(publicTrace(nested, log)).toEqual(publicTrace(combined, log))
    }), { numRuns: 500 })
  })

  test("grouping three policy transformations is associative", () => {
    fc.assert(fc.property(claims, logs, fc.nat(30), (specs, log, limit) => {
      const child = merge("assembly", specs.map(leaf))
      const reverse: TransitionReconciler = (_events, transitions) => [...transitions].reverse()
      const left = composePolicies(reverse, composePolicies(capacity(limit), permissions))
      const right = composePolicies(composePolicies(reverse, capacity(limit)), permissions)
      expect(publicTrace(wrap("left", child, left), log)).toEqual(publicTrace(wrap("right", child, right), log))
    }))
  })

  test("selection preserves proposal identity and cannot recover suppressed work at the actor boundary", () => {
    fc.assert(fc.property(claims, fc.nat(30), (specs, limit) => {
      const child = merge("assembly", specs.map(leaf))
      const checked: TransitionReconciler = (log, proposals, view) => {
        const selected = capacity(limit)(log, proposals, view)
        for (const proposal of selected) expect(proposals.includes(proposal)).toBe(true)
        return selected
      }
      const governed = wrap("budget", wrap("permissions", child, permissions), checked)
      const root = actor({ name: "root", methods: {}, components: [governed] })
      const actual = enabled(root, ready)
      expect(actual.map(claimOf)).toEqual(replayProjection(machineOf(governed), ready).transitions.map(claimOf))
      expect(actual.every((transition) => claimOf(transition).permission === "read")).toBe(true)
      expect(actual.reduce((sum, transition) => sum + claimOf(transition).cost, 0)).toBeLessThanOrEqual(limit)
    }))
  })

  test("regrouped equivalent children remain equivalent under these interface-based parents", () => {
    fc.assert(fc.property(claims, logs, fc.nat(30), (specs, log, limit) => {
      const leaves = specs.map(leaf)
      const flat = merge("flat", leaves)
      const grouped = merge("grouped", [merge("first", leaves.slice(0, 1)), merge("rest", leaves.slice(1))])
      const policy = composePolicies(capacity(limit), permissions)
      expect(publicTrace(wrap("p-flat", flat, policy), log)).toEqual(publicTrace(wrap("p-grouped", grouped, policy), log))
    }))
  })
})

describe("equations composition does not promise", () => {
  test("arbitrary view projections need not preserve regrouping", () => {
    const average = ([a, b]: readonly [number, number]) => Math.floor((a + b) / 2)
    const a = counter("a", 0)
    const b = counter("b", 0)
    const c = counter("c", 2)
    const ab = composeComponents("ab", { empty: 0, combine: (a: number, b: number) => average([a, b]) }, [a, b])
    const bc = composeComponents("bc", { empty: 0, combine: (a: number, b: number) => average([a, b]) }, [b, c])
    const left = composeComponents("left", { empty: 0, combine: (a: number, b: number) => average([a, b]) }, [ab, c])
    const right = composeComponents("right", { empty: 0, combine: (a: number, b: number) => average([a, b]) }, [a, bc])
    const leftState = replayState(machineOf(left), [])
    const rightState = replayState(machineOf(right), [])
    expect(machineOf(left).output(leftState).view).not.toEqual(machineOf(right).output(rightState).view)
    expect(machineOf(left).output(leftState).transitions).toEqual(machineOf(right).output(rightState).transitions)
    expect(machineOf(left).output(leftState).view).toBe(1)
    expect(machineOf(right).output(rightState).view).toBe(0)
  })

  test("equal views now do not establish equal future behavior", () => {
    const countdown = (initial: number) => component({
      name: "countdown", initial: () => initial,
      step: (state, event) => event.type === "Tick" ? Math.max(0, state - 1) : state,
      output: (state) => ({ view: { active: state > 0 }, transitions: [] })
    })
    const a = countdown(1)
    const b = countdown(2)
    const aState = replayState(machineOf(a), [])
    const bState = replayState(machineOf(b), [])
    expect(machineOf(a).output(aState).view).toEqual(machineOf(b).output(bState).view)
    expect(machineOf(a).output(aState)).toEqual(machineOf(b).output(bState))
    expect(machineOf(a).output(replayState(machineOf(a), [{ type: "Tick" }])).view).not.toEqual(machineOf(b).output(replayState(machineOf(b), [{ type: "Tick" }])).view)
  })

  test("permission and capacity selection do not commute", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10 }), (cost) => {
      const child = merge("assembly", [
        leaf({ id: "write", cost, permission: "write", kind: "effect" }),
        leaf({ id: "read", cost, permission: "read", kind: "effect" })
      ])
      const permissionFirst = wrap("budget", wrap("permissions", child, permissions), capacity(cost))
      const budgetFirst = wrap("permissions", wrap("budget", child, capacity(cost)), permissions)
      expect(replayProjection(machineOf(permissionFirst), ready).transitions.map(claimOf).map((claim) => claim.id)).toEqual(["read"])
      expect(replayProjection(machineOf(budgetFirst), ready).transitions).toEqual([])
    }))
  })

  test("shared capacity does not distribute into independent sibling capacities", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10 }), (cost) => {
      const a = leaf({ id: "a", cost, permission: "read", kind: "effect" })
      const b = leaf({ id: "b", cost, permission: "read", kind: "effect" })
      const shared = wrap("shared", merge("ab", [a, b]), capacity(cost))
      const independent = merge("independent", [wrap("a-budget", a, capacity(cost)), wrap("b-budget", b, capacity(cost))])
      expect(replayProjection(machineOf(shared), ready).transitions.map(claimOf).map((claim) => claim.id)).toEqual(["a"])
      expect(replayProjection(machineOf(independent), ready).transitions.map(claimOf).map((claim) => claim.id)).toEqual(["a", "b"])
    }))
  })
})
