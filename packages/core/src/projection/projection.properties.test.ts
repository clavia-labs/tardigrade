import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/event"
import { materializeProjection, replayProjection, type Projection } from "./projection"

const INPUTS = ["A", "B", "C"] as const

type Input = typeof INPUTS[number]

interface FiniteMooreDefinition {
  readonly states: number
  readonly initial: number
  readonly transitions: ReadonlyArray<number>
  readonly outputs: ReadonlyArray<number>
}

const definitionArbitrary: fc.Arbitrary<FiniteMooreDefinition> = fc.integer({ min: 1, max: 8 }).chain((states) =>
  fc.record({
    states: fc.constant(states),
    initial: fc.integer({ min: 0, max: states - 1 }),
    transitions: fc.array(fc.integer({ min: 0, max: states - 1 }), {
      minLength: states * INPUTS.length,
      maxLength: states * INPUTS.length
    }),
    outputs: fc.array(fc.integer(), { minLength: states, maxLength: states })
  })
)

const eventArbitrary = fc.constantFrom(...INPUTS).map((type): Event => ({ type }))

const wordArbitrary = fc.array(eventArbitrary, { maxLength: 40 })

const inputIndex = (event: Event): number => INPUTS.indexOf(event.type as Input)

const projectionOf = (definition: FiniteMooreDefinition): Projection<number, number> => ({
  initial: () => definition.initial,
  step: (state, event) => definition.transitions[state * INPUTS.length + inputIndex(event)]!,
  output: (state) => definition.outputs[state]!
})

const advance = (
  projection: Projection<number, number>,
  state: number,
  word: ReadonlyArray<Event>
): number => word.reduce(projection.step, state)

describe("finite Moore machine laws", () => {
  test("the empty word preserves the initial state and its output", () => {
    fc.assert(fc.property(definitionArbitrary, (definition) => {
      const projection = projectionOf(definition)
      const initial = projection.initial()

      expect(advance(projection, initial, [])).toBe(initial)
      expect(replayProjection(projection, [])).toBe(projection.output(initial))
    }))
  })

  test("word concatenation composes state transitions", () => {
    fc.assert(fc.property(
      definitionArbitrary,
      wordArbitrary,
      wordArbitrary,
      (definition, prefix, suffix) => {
        const projection = projectionOf(definition)
        const initial = projection.initial()
        const throughPrefix = advance(projection, initial, prefix)

        expect(advance(projection, initial, [...prefix, ...suffix]))
          .toBe(advance(projection, throughPrefix, suffix))
      }
    ))
  })

  test("replay observes the state reached by the complete word", () => {
    fc.assert(fc.property(definitionArbitrary, wordArbitrary, (definition, word) => {
      const projection = projectionOf(definition)
      const reached = advance(projection, projection.initial(), word)

      expect(replayProjection(projection, word)).toBe(projection.output(reached))
    }))
  })

  test("histories in the same state remain indistinguishable under every suffix", () => {
    fc.assert(fc.property(
      definitionArbitrary,
      wordArbitrary,
      wordArbitrary,
      wordArbitrary,
      (definition, left, right, suffix) => {
        const projection = projectionOf(definition)
        const leftState = advance(projection, projection.initial(), left)
        const rightState = advance(projection, projection.initial(), right)
        fc.pre(leftState === rightState)

        expect(projection.output(advance(projection, leftState, suffix)))
          .toBe(projection.output(advance(projection, rightState, suffix)))
      }
    ))
  })

  test("materialization preserves the output at every history prefix", () => {
    fc.assert(fc.property(definitionArbitrary, wordArbitrary, (definition, word) => {
      const projection = projectionOf(definition)
      const materialized = materializeProjection(projection)
      let state = projection.initial()
      let cached = materialized.initial()

      expect(materialized.output(cached)).toBe(projection.output(state))
      for (const event of word) {
        state = projection.step(state, event)
        cached = materialized.step(cached, event)
        expect(materialized.output(cached)).toBe(projection.output(state))
      }
    }))
  })
})
