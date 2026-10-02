import { describe, expect, test } from "bun:test"
import { materializeProjection, replayState, replayProjection, type Projection } from "./projection"
import { eventAt, eventPositionOf } from "../event"

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
  test("replayState preserves positions and leaves the readout to the caller", () => {
    const positions: Array<number | undefined> = []
    let reads = 0
    const projection: Projection<CountState, number> = {
      ...counts,
      step: (state, event) => {
        positions.push(eventPositionOf(event))
        return counts.step(state, event)
      },
      output: (state) => { reads++; return counts.output(state) }
    }
    const state = replayState(projection, [
      { type: "Accepted" }, eventAt({ type: "Rejected" }, 17)
    ])
    expect(state).toEqual({ accepted: 1, rejected: 1 })
    expect(positions).toEqual([1, 17])
    expect(reads).toBe(0)
    expect(projection.output(state)).toBe(0)
    expect(reads).toBe(1)
    expect(positions).toEqual([1, 17])
    expect(replayState(projection, [])).toEqual(counts.initial())
    expect(replayProjection(counts, [{ type: "Accepted" }])).toBe(1)
  })

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
