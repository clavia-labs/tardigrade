import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { initialTurnProjection, reduceTurnProjection, trajectoryFrom, turnViewFrom } from "./turn-projection"
import { trajectoryOf, turnView } from "./turns"

const eventOf = (kind: number, turn: string, epoch: number, ordinal: number): Event => {
  const stamp = epoch === 0 ? {} : { epoch }
  if (kind === 0) return { type: "ModelCalled", turn, ...stamp, ordinal } as Event
  if (kind === 1) return { type: "ToolCalled", callId: `${turn}/${ordinal}`, turn, ...stamp } as Event
  if (kind === 2) return { type: "ToolReturned", callId: `${turn}/${ordinal}`, turn, ...stamp } as Event
  if (kind === 3) return { type: "TurnFailed", turn, ...stamp } as Event
  if (kind === 4) return { type: "TurnCompleted", turn, ...stamp } as Event
  if (kind === 5) return { type: "TurnCancelled", turn, ...stamp } as Event
  return { type: "TurnResumed", turn, failedEpoch: Math.max(0, epoch - 1), epoch } as Event
}

describe("incremental turn projection", () => {
  test("agrees with complete replay over queued turn histories", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        kind: fc.integer({ min: 0, max: 5 }),
        turn: fc.constantFrom("m0", "m1"),
        epoch: fc.constant(0)
      }), { maxLength: 80 }),
      (steps) => {
        const log: ReadonlyArray<Event> = [
          { type: "MessageReceived", id: "m0" } as Event,
          { type: "MessageReceived", id: "m1" } as Event,
          ...steps.map((step, index) => eventOf(step.kind, step.turn, step.epoch, index))
        ]
        const state = log.reduce(reduceTurnProjection, initialTurnProjection())
        expect(turnViewFrom(state)).toEqual(turnView(log))
        expect(trajectoryFrom(state)).toEqual(trajectoryOf(log))
      }
    ), { numRuns: 500 })
  })

  test("a parked package reply does not become a turn head", () => {
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m0" } as Event,
      { type: "PackageCalled", callId: "run-1", turn: "m0" } as Event,
      { type: "MessageReceived", id: "run-1/reply" } as Event,
      { type: "PackageReturned", callId: "run-1", turn: "m0" } as Event,
      { type: "TurnCompleted", turn: "m0" } as Event
    ]
    const state = log.reduce(reduceTurnProjection, initialTurnProjection())

    expect(turnViewFrom(state)).toEqual(turnView(log))
    expect(trajectoryFrom(state)).toEqual(trajectoryOf(log))
  })

  test("a failed turn reopens in its resumed epoch", () => {
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m0" } as Event,
      { type: "TurnFailed", turn: "m0" } as Event,
      { type: "TurnResumed", turn: "m0", failedEpoch: 0, epoch: 1 } as Event,
      { type: "ModelCalled", turn: "m0", epoch: 1 } as Event
    ]
    const state = log.reduce(reduceTurnProjection, initialTurnProjection())

    expect(turnViewFrom(state)).toEqual(turnView(log))
    expect(trajectoryFrom(state)).toEqual(trajectoryOf(log))
  })
})
