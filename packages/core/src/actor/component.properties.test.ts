import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { enabled, intent, effect } from "../reconciliation"
import {
  actor,
  composeComponents,
  type Component,
  type TransitionReconciler,
  type ViewAlgebra
} from "./index"
import type { Event } from "../log/event"

interface Facts {
  readonly names: ReadonlyArray<string>
}

interface Leaf {
  readonly id: number
  readonly trigger: "A" | "B" | "C"
}

const facts: ViewAlgebra<Facts> = {
  empty: { names: [] },
  combine: (left, right) => ({ names: [...left.names, ...right.names] })
}

const leafComponent = (leaf: Leaf): Component<Facts> => {
  const name = `leaf-${leaf.id}`
  const key = `${name}:work`
  return {
    name,
    keys: {
      prefixes: [`${name}:`],
      keyOf: (event) =>
        event.type === "Committed" && Number((event as { owner?: unknown }).owner) === leaf.id
          ? key
          : undefined
    },
    derive: (log) => {
      const visible = log.some(
        (event) => event.type === "Triggered" && String((event as { trigger?: unknown }).trigger) === leaf.trigger
      )
      return {
        view: { names: visible ? [name] : [] },
        transitions: visible
          ? [effect({ key, input: { owner: leaf.id }, act: () => Effect.succeed([]) })]
          : []
      }
    }
  }
}

const regroup = (
  leaves: ReadonlyArray<Component<Facts>>,
  choices: ReadonlyArray<number>
): Component<Facts> => {
  if (leaves.length === 0) return composeComponents("nested-empty", facts, [])
  const nodes = [...leaves]
  let step = 0
  while (nodes.length > 1) {
    const choice = choices[step % Math.max(choices.length, 1)] ?? 0
    const index = choice % (nodes.length - 1)
    const pair = composeComponents(`nested-${step}`, facts, [nodes[index]!, nodes[index + 1]!])
    nodes.splice(index, 2, pair)
    step += 1
  }
  return nodes[0]!
}

const transitionFacts = (transitions: ReturnType<typeof enabled>) =>
  transitions.map((owed) => ({ key: owed.key, input: owed.input }))

const leavesArbitrary = fc.uniqueArray(
  fc.record({ id: fc.integer({ min: 0, max: 30 }), trigger: fc.constantFrom("A", "B", "C") }),
  { selector: (leaf) => leaf.id, maxLength: 10 }
)

const logArbitrary = fc.array(
  fc.oneof(
    fc.record({ type: fc.constant("Triggered"), trigger: fc.constantFrom("A", "B", "C") }),
    fc.record({ type: fc.constant("Committed"), owner: fc.integer({ min: 0, max: 30 }) }),
    fc.record({ type: fc.constant("Ignored"), value: fc.integer() })
  ),
  { maxLength: 30 }
) as fc.Arbitrary<ReadonlyArray<Event>>

describe("recursive component composition", () => {
  test("every grouping agrees with the flat composition", () => {
    fc.assert(
      fc.property(
        leavesArbitrary,
        fc.array(fc.nat(), { maxLength: 20 }),
        logArbitrary,
        (leafSpecs, choices, log) => {
          const leaves = leafSpecs.map(leafComponent)
          const flat = composeComponents("flat", facts, leaves)
          const nested = regroup(leaves, choices)
          const flatDerivation = flat.derive(log)
          const nestedDerivation = nested.derive(log)

          expect(nestedDerivation.view).toEqual(flatDerivation.view)
          expect(nestedDerivation.transitions.map((owed) => ({ key: owed.key, input: owed.input }))).toEqual(
            flatDerivation.transitions.map((owed) => ({ key: owed.key, input: owed.input }))
          )
          expect(nested.keys?.prefixes).toEqual(flat.keys?.prefixes)
          for (const event of log) expect(nested.keys?.keyOf(event)).toBe(flat.keys?.keyOf(event))
          const nestedActor = actor({ name: "nested", methods: {}, components: [nested] })
          const flatActor = actor({ name: "flat", methods: {}, components: [flat] })
          expect(transitionFacts(enabled(nestedActor, log))).toEqual(transitionFacts(enabled(flatActor, log)))
        }
      ),
      { numRuns: 500 }
    )
  })
})

interface Claim {
  readonly id: number
  readonly kind: "intent" | "effect"
  readonly capability: "read" | "write" | "admin"
  readonly cost: number
  readonly suppresses: ReadonlyArray<number>
}

const claimComponent = (claim: Claim): Component<Facts> => ({
  name: `claim-${claim.id}`,
  derive: () => ({
    view: { names: [`claim-${claim.id}`] },
    transitions: [
      claim.kind === "intent"
        ? intent({ key: `claim:${claim.id}`, input: claim, events: () => [] })
        : effect({ key: `claim:${claim.id}`, input: claim, act: () => Effect.succeed([]) })
    ]
  })
})

const claimOf = (transition: { readonly input: never }): Claim => transition.input as unknown as Claim

const claimsArbitrary = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 0, max: 30 }),
    kind: fc.constantFrom("intent", "effect"),
    capability: fc.constantFrom("read", "write", "admin"),
    cost: fc.integer({ min: 1, max: 8 }),
    suppresses: fc.uniqueArray(fc.integer({ min: 0, max: 30 }), { maxLength: 8 })
  }),
  { selector: (claim) => claim.id, maxLength: 12 }
)

const permissionsFor = (granted: ReadonlySet<Claim["capability"]>): TransitionReconciler =>
  (_events, transitions) => transitions.filter((transition) => granted.has(claimOf(transition).capability))

const capacityFor = (capacity: number): TransitionReconciler => (_events, transitions) => {
  let remaining = capacity
  return transitions.filter((transition) => {
    const cost = claimOf(transition).cost
    if (cost > remaining) return false
    remaining -= cost
    return true
  })
}

describe("transition reconciliation", () => {
  test("directional suppression never exposes a suppressed pair", () => {
    fc.assert(
      fc.property(claimsArbitrary, (claims) => {
        const reconcile: TransitionReconciler = (_events, transitions) => {
          const suppressed = new Set(transitions.flatMap((transition) => claimOf(transition).suppresses))
          return transitions.filter((transition) => !suppressed.has(claimOf(transition).id))
        }
        const composed = composeComponents("suppression", facts, claims.map(claimComponent), { reconcile })
        const selected = composed.derive([]).transitions.map(claimOf)
        const selectedIds = new Set(selected.map((claim) => claim.id))

        for (const claim of selected) {
          for (const suppressed of claim.suppresses) expect(selectedIds.has(suppressed)).toBe(false)
        }
      }),
      { numRuns: 500 }
    )
  })

  test("permission reconciliation exposes only authorized capabilities", () => {
    fc.assert(
      fc.property(
        claimsArbitrary,
        fc.uniqueArray(fc.constantFrom("read", "write", "admin")),
        (claims, grants) => {
          const granted = new Set(grants)
          const composed = composeComponents("permissions", facts, claims.map(claimComponent), {
            reconcile: permissionsFor(granted)
          })

          expect(composed.derive([]).transitions.map(claimOf).map((claim) => claim.id)).toEqual(
            claims.filter((claim) => granted.has(claim.capability)).map((claim) => claim.id)
          )
        }
      ),
      { numRuns: 500 }
    )
  })

  test("capacity reconciliation never exposes more cost than remains", () => {
    fc.assert(
      fc.property(claimsArbitrary, fc.integer({ min: 0, max: 30 }), (claims, capacity) => {
        const composed = composeComponents("capacity", facts, claims.map(claimComponent), {
          reconcile: capacityFor(capacity)
        })
        const selected = composed.derive([]).transitions.map(claimOf)

        expect(selected.reduce((spent, claim) => spent + claim.cost, 0)).toBeLessThanOrEqual(capacity)
      }),
      { numRuns: 500 }
    )
  })

  test("nested policy boundaries reconcile children before parents", () => {
    fc.assert(
      fc.property(
        claimsArbitrary,
        fc.uniqueArray(fc.constantFrom("read", "write", "admin")),
        fc.integer({ min: 0, max: 30 }),
        (claims, grants, capacity) => {
          const granted = new Set(grants)
          const authorized = composeComponents("permissions", facts, claims.map(claimComponent), {
            reconcile: permissionsFor(granted)
          })
          const observedByParent: number[] = []
          const bounded = composeComponents("capacity", facts, [authorized], {
            reconcile: (events, transitions) => {
              observedByParent.push(...transitions.map((transition) => claimOf(transition).id))
              return capacityFor(capacity)(events, transitions)
            }
          })
          const resolved = bounded.derive([]).transitions.map(claimOf)
          const authorizedClaims = claims.filter((claim) => granted.has(claim.capability))

          expect(observedByParent).toEqual(authorizedClaims.map((claim) => claim.id))
          expect(resolved.every((claim) => granted.has(claim.capability))).toBe(true)
          expect(resolved.reduce((spent, claim) => spent + claim.cost, 0)).toBeLessThanOrEqual(capacity)
        }
      ),
      { numRuns: 500 }
    )
  })
})
