import { machineOf } from "../runtime"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { effect } from "@clavia/tardigrade-core/effect"
import { intent } from "@clavia/tardigrade-core/intent"
import type { TransitionContext } from "../../transition/transition"
import { composeComponents, component, legacyComponent, type Component, type TransitionReconciler, type ViewAlgebra } from "../index"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"

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

const incrementalLeafComponent = (leaf: Leaf): Component<Facts> => {
  const name = `leaf-${leaf.id}`
  return component({

    name,
    initial: (): TransitionContext | undefined => undefined,
    step: (owner, event, ctx) => owner ??
      (event.type === "Triggered" && String(event.trigger) === leaf.trigger ? ctx : undefined),
    output: (owner) => ({
      view: { names: owner === undefined ? [] : [name] },
      transitions: owner === undefined ? [] : [owner.effect("commit", {
        input: { owner: leaf.id }, act: (input) => Effect.succeed({ type: "Committed", ...input })
      })]
    })
  })
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
  test("the composed machine is the synchronous product of its children", () => {
    fc.assert(
      fc.property(leavesArbitrary, logArbitrary, (leafSpecs, log) => {
        const children = leafSpecs.map(incrementalLeafComponent)
        const machines = children.map((child) => machineOf(child))
        const composed = machineOf(composeComponents("product", facts, children))
        let childStates = machines.map((machine) => machine.initial())
        let composedState = composed.initial()

        for (let length = 0; length <= log.length; length++) {
          const childOutputs = machines.map((machine, index) => machine.output(childStates[index]!))
          const expected = {
            view: childOutputs.reduce(
              (view, output) => facts.combine(view, output.view),
              facts.empty
            ),
            transitions: childOutputs.flatMap((output) => output.transitions)
          }
          const observed = composed.output(composedState)

          expect(observed.view).toEqual(expected.view)
          expect(observed.transitions.map((transition) => ({ key: transition.key, input: transition.input }))).toEqual(
            expected.transitions.map((transition) => ({ key: transition.key, input: transition.input }))
          )

          const event = log[length]
          if (event !== undefined) {
            childStates = machines.map((machine, index) => machine.step(childStates[index]!, eventAt(event, length + 1)))
            composedState = composed.step(composedState, eventAt(event, length + 1))
          }
        }
      }),
      { numRuns: 500 }
    )
  })

  test("every incremental grouping agrees with complete replay at every prefix", () => {
    fc.assert(
      fc.property(
        leavesArbitrary,
        fc.array(fc.nat(), { maxLength: 20 }),
        logArbitrary,
        (leafSpecs, choices, log) => {
          const leaves = leafSpecs.map(incrementalLeafComponent)
          const flat = composeComponents("flat-incremental", facts, leaves)
          const nested = regroup(leaves, choices)
          const flatProjection = machineOf(flat)
          const nestedProjection = machineOf(nested)
          let flatState = flatProjection.initial()
          let nestedState = nestedProjection.initial()

          for (let length = 0; length <= log.length; length++) {
            const prefix = log.slice(0, length)
            const expected = replayProjection(machineOf(flat), prefix)
            const views = [
              replayProjection(machineOf(nested), prefix),
              flatProjection.output(flatState),
              nestedProjection.output(nestedState)
            ]
            for (const observed of views) {
              expect(observed.view).toEqual(expected.view)
              expect(observed.transitions.map((transition) => ({ key: transition.key, input: transition.input })))
                .toEqual(expected.transitions.map((transition) => ({ key: transition.key, input: transition.input })))
            }
            const event = log[length]
            if (event !== undefined) {
              flatState = flatProjection.step(flatState, eventAt(event, length + 1))
              nestedState = nestedProjection.step(nestedState, eventAt(event, length + 1))
            }
          }
        }
      ),
      { numRuns: 500 }
    )
  })
})

interface Claim {
  readonly id: number
  readonly kind: "intent" | "effect"
  readonly suppresses: ReadonlyArray<number>
}

const claimComponent = (claim: Claim): Component<Facts> => legacyComponent({
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
    suppresses: fc.uniqueArray(fc.integer({ min: 0, max: 30 }), { maxLength: 8 })
  }),
  { selector: (claim) => claim.id, maxLength: 12 }
)

describe("transition reconciliation", () => {
  test("directional suppression never exposes a suppressed pair", () => {
    fc.assert(
      fc.property(claimsArbitrary, (claims) => {
        const reconcile: TransitionReconciler = (_events, transitions) => {
          const suppressed = new Set(transitions.flatMap((transition) => claimOf(transition).suppresses))
          return transitions.filter((transition) => !suppressed.has(claimOf(transition).id))
        }
        const composed = composeComponents("suppression", facts, claims.map(claimComponent), { reconcile })
        const selected = replayProjection(machineOf(composed), []).transitions.map(claimOf)
        const selectedIds = new Set(selected.map((claim) => claim.id))

        for (const claim of selected) {
          for (const suppressed of claim.suppresses) expect(selectedIds.has(suppressed)).toBe(false)
        }
      }),
      { numRuns: 500 }
    )
  })
})
