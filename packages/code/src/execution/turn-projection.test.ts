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

  test("an invocation response does not become a turn head", () => {
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m0" } as Event,
      { type: "PackageCalled", callId: "run-1", turn: "m0" } as Event,
      { type: "BlockedOn", callId: "run-1", turn: "m0", awaiting: "run-1/reply" },
      { type: "ResponseReceived", id: "run-1/reply" } as Event,
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

  test("a resume cannot skip execution epochs", () => {
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m0" } as Event,
      { type: "TurnFailed", turn: "m0" } as Event,
      { type: "TurnResumed", turn: "m0", failedEpoch: 0, epoch: 7 } as Event
    ]
    const state = log.reduce(reduceTurnProjection, initialTurnProjection())

    expect(turnViewFrom(state)).toEqual(turnView(log))
    expect(trajectoryFrom(state)).toEqual(trajectoryOf(log))
  })
})

test("message and response event types determine whether a turn starts", () => {
  const check = (events: ReadonlyArray<Event>, expected: string | undefined) => {
    expect(turnView(events)[0]?.id).toBe(expected)
    expect(turnViewFrom(events.reduce(reduceTurnProjection, initialTurnProjection()))[0]?.id).toBe(expected)
  }
  const call: Event = { type: "PackageCalled", callId: "same", turn: "owner" }
  check([call, { type: "MessageReceived", id: "same.reply" }], "same.reply")
  check([call, { type: "BlockedOn", callId: "same", turn: "owner", awaiting: "opaque-response" },
    { type: "MessageReceived", id: "opaque-response" }], "opaque-response")
  check([call, { type: "BlockedOn", callId: "same", turn: "other", awaiting: "opaque-response" },
    { type: "MessageReceived", id: "opaque-response" }], "opaque-response")
  check([call, { type: "ResponseReceived", id: "same.reply" }], undefined)
})

test("event types preserve turn attribution regardless of waits, ID suffixes, and replay", () => {
  fc.assert(fc.property(
    fc.string({ minLength: 1, maxLength: 20 }), fc.boolean(), fc.boolean(), fc.boolean(),
    (base, waited, closed, isMessage) => {
      const reply = `${base}.reply`
      const first = { seq: 12, component: "code", tag: "dispatch" }
      const second = { seq: 19, component: "code", tag: "dispatch" }
      const call: Event = { type: "PackageCalled", executionRef: first, ordinal: 0, callId: base, turn: "owner" }
      const returned: Event = { type: "PackageReturned", executionRef: first, ordinal: 0, callId: base, turn: "owner" }
      const history: Event[] = [
        call,
        { type: "PackageCalled", executionRef: second, ordinal: 0, callId: base, turn: "owner" },
        { type: "PackageReturned", executionRef: second, ordinal: 0, callId: base, turn: "owner" },
        ...(waited ? [{ type: "BlockedOn", executionRef: first, ordinal: 0, callId: base, turn: "owner", awaiting: reply }] : []),
        ...(closed ? [returned] : []),
        { type: isMessage ? "MessageReceived" : "ResponseReceived", id: reply }
      ]
      const expected = isMessage ? reply : undefined
      for (const log of [history, [...history, returned], JSON.parse(JSON.stringify(history)) as Event[]]) {
        expect(turnView(log)[0]?.id).toBe(expected)
        expect(turnViewFrom(log.reduce(reduceTurnProjection, initialTurnProjection()))[0]?.id).toBe(expected)
      }
    }
  ), { numRuns: 200 })
})
