import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { boundaryOf, outputOf } from "./boundary"
import { output } from "./output"

const base: Event[] = [{ type: "MessageReceived", id: "m1", text: "go", at: 0 }]

describe("boundaryOf", () => {
  test("a running turn has no boundary yet", () => {
    expect(boundaryOf(base, "m1")).toBeUndefined()
  })

  test("a completed turn returns its output", () => {
    const log = [...base, { type: "TurnCompleted", output: "done", turn: "m1", at: 1 } as Event]
    expect(boundaryOf(log, "m1")).toEqual({ kind: "completed", output: "done" })
  })

  test("a failed turn returns its error", () => {
    const log = [...base, { type: "TurnFailed", error: "boom", turn: "m1", at: 1 } as Event]
    expect(boundaryOf(log, "m1")).toEqual({ kind: "failed", error: "boom" })
  })

  test("a turn parked on an ask returns the request", () => {
    const log = [...base, { type: "BudgetRequested", callId: "rb1", reason: "need more", amount: 5, turn: "m1", at: 1 } as Event]
    expect(boundaryOf(log, "m1")).toEqual({ kind: "requesting", callId: "rb1", reason: "need more", amount: 5 })
  })

  test("a grant clears the ask; the turn is running again, not requesting", () => {
    const log = [
      ...base,
      { type: "BudgetRequested", callId: "rb1", reason: "need more", amount: 5, turn: "m1", at: 1 } as Event,
      { type: "BudgetGranted", amount: 5, turn: "m1", at: 2 } as Event
    ]
    expect(boundaryOf(log, "m1")).toBeUndefined()
  })

  test("a terminal wins over an earlier ask: a resumed turn that finished reads completed", () => {
    const log = [
      ...base,
      { type: "BudgetRequested", callId: "rb1", reason: "need more", amount: 5, turn: "m1", at: 1 } as Event,
      { type: "BudgetGranted", amount: 5, turn: "m1", at: 2 } as Event,
      { type: "TurnCompleted", output: "done", turn: "m1", at: 3 } as Event
    ]
    expect(boundaryOf(log, "m1")).toEqual({ kind: "completed", output: "done" })
  })

  test("a second ask after a grant is the pending boundary", () => {
    const log = [
      ...base,
      { type: "BudgetRequested", callId: "rb1", reason: "first", amount: 5, turn: "m1", at: 1 } as Event,
      { type: "BudgetGranted", amount: 5, turn: "m1", at: 2 } as Event,
      { type: "BudgetRequested", callId: "rb2", reason: "second", amount: 3, turn: "m1", at: 3 } as Event
    ]
    expect(boundaryOf(log, "m1")).toEqual({ kind: "requesting", callId: "rb2", reason: "second", amount: 3 })
  })

  test("a resume request clears the failed boundary until the next terminal", () => {
    const resumed = [
      ...base,
      { type: "TurnFailed", error: "timeout", turn: "m1", at: 1 } as Event,
      { type: "TurnResumed", turn: "m1", failedEpoch: 0, epoch: 1, at: 2 } as Event
    ]
    expect(boundaryOf(resumed, "m1")).toBeUndefined()
    expect(
      boundaryOf([...resumed, { type: "TurnCompleted", output: "done", turn: "m1", epoch: 1, at: 3 } as Event], "m1")
    ).toEqual({ kind: "completed", output: "done" })
  })
})

describe("outputOf", () => {
  const CONTRACT = output({
    name: "note",
    schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false }
  })

  test("a completed turn reads back as its contract's value", () => {
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "go", output: { name: CONTRACT.name, schema: CONTRACT.schema }, at: 0 },
      { type: "TurnCompleted", output: '{"a":"one"}', turn: "m1", at: 1 }
    ]
    expect(outputOf(CONTRACT, log, "m1")).toEqual({ a: "one" })
  })

  test("a running turn and a failed turn have no answer to read", () => {
    expect(outputOf(CONTRACT, [{ type: "MessageReceived", id: "m1", text: "go", at: 0 }], "m1")).toBeUndefined()
    expect(
      outputOf(CONTRACT, [{ type: "TurnFailed", error: "refused", turn: "m1", at: 1 }], "m1")
    ).toBeUndefined()
  })

  test("a recorded answer that misses its contract is loud, never a value nobody can trust", () => {
    const log: ReadonlyArray<Event> = [{ type: "TurnCompleted", output: '{"a":1}', turn: "m1", at: 1 }]
    expect(() => outputOf(CONTRACT, log, "m1")).toThrow('misses the contract "note"')
  })
})
