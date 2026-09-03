import { describe, expect, test } from "bun:test"
import { materializeProjection, type Projection } from "./projection"

interface CountState {
  readonly accepted: number
  readonly rejected: number
}

const counts: Projection<CountState, number> = {
  initial: () => ({ accepted: 0, rejected: 0 }),
  step: (state, event) => event.type === "Accepted"
    ? { ...state, accepted: state.accepted + 1 }
    : event.type === "Rejected"
      ? { ...state, rejected: state.rejected + 1 }
      : state,
  output: (state) => state.accepted - state.rejected
}

describe("projection", () => {
  test("materialization reuses the value while state identity is stable", () => {
    let derivations = 0
    const materialized = materializeProjection({
      ...counts,
      output: (state: CountState) => {
        derivations += 1
        return counts.output(state)
      }
    })
    const initial = materialized.initial()
    const ignored = materialized.step(initial, { type: "Ignored" })
    const accepted = materialized.step(ignored, { type: "Accepted" })

    expect(ignored).toBe(initial)
    expect(materialized.output(ignored)).toBe(0)
    expect(accepted).not.toBe(ignored)
    expect(materialized.output(accepted)).toBe(1)
    expect(derivations).toBe(2)
  })
})
