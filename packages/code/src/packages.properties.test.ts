import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { composeComponents } from "@clavia/tardigrade-core/component"
import {
  CODE_VIEW_ALGEBRA,
  definePackage,
  type CodeComponent,
  type Package
} from "./packages"

const packageFor = (name: string): Package =>
  definePackage({
    name,
    description: `${name} package`,
    methods: { read: () => Effect.succeed(name) }
  })

const regroup = (
  leaves: ReadonlyArray<CodeComponent>,
  choices: ReadonlyArray<number>
): CodeComponent => {
  if (leaves.length === 0) return composeComponents("nested-empty", CODE_VIEW_ALGEBRA, [])
  const nodes = [...leaves]
  let step = 0
  while (nodes.length > 1) {
    const choice = choices[step % Math.max(choices.length, 1)] ?? 0
    const index = choice % (nodes.length - 1)
    const pair = composeComponents(`nested-${step}`, CODE_VIEW_ALGEBRA, [nodes[index]!, nodes[index + 1]!])
    nodes.splice(index, 2, pair)
    step += 1
  }
  return nodes[0]!
}

const namesOf = (component: CodeComponent): ReadonlyArray<string> =>
  component.derive([]).view.packages.map((pkg) => pkg.name)

describe("recursive code component composition", () => {
  test("every grouping preserves package identity and order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/), { maxLength: 12 }),
        fc.array(fc.nat(), { maxLength: 24 }),
        (names, choices) => {
          const leaves = names.map(packageFor)
          const flat = composeComponents("flat", CODE_VIEW_ALGEBRA, leaves)
          const nested = regroup(leaves, choices)

          expect(namesOf(nested)).toEqual(namesOf(flat))
          expect(nested.derive([]).view.packages).toEqual(leaves)
          expect(nested.derive([]).transitions).toEqual([])
        }
      ),
      { numRuns: 500 }
    )
  })
})
