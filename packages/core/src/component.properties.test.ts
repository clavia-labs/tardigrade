import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { enabled, transition } from "./actor"
import { actor, composeComponents, type Component, type ViewAlgebra } from "./component"
import type { Event } from "./event"

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
          ? [transition({ key, input: { owner: leaf.id }, act: () => Effect.succeed([]) })]
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
          expect(transitionFacts(enabled(actor(nested), log))).toEqual(transitionFacts(enabled(actor(flat), log)))
        }
      ),
      { numRuns: 500 }
    )
  })
})
