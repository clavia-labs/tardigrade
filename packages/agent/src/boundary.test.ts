import { describe, expect, test } from "bun:test"
import type { Envelope } from "@flamecast/core/envelope"
import { boundaryOf } from "./boundary"

const base: Envelope[] = [{ type: "MessageReceived", id: "m1", text: "go", at: 0 }]

describe("boundaryOf", () => {
  test("a running turn has no boundary yet", () => {
    expect(boundaryOf(base, "m1")).toBeUndefined()
  })

  test("a completed turn returns its output", () => {
    const log = [...base, { type: "TurnCompleted", output: "done", turn: "m1", at: 1 } as Envelope]
    expect(boundaryOf(log, "m1")).toEqual({ kind: "completed", output: "done" })
  })

  test("a failed turn returns its error", () => {
    const log = [...base, { type: "TurnFailed", error: "boom", turn: "m1", at: 1 } as Envelope]
    expect(boundaryOf(log, "m1")).toEqual({ kind: "failed", error: "boom" })
  })

  test("a turn parked on an ask returns the request", () => {
    const log = [...base, { type: "BudgetRequested", callId: "rb1", reason: "need more", amount: 5, turn: "m1", at: 1 } as Envelope]
    expect(boundaryOf(log, "m1")).toEqual({ kind: "requesting", callId: "rb1", reason: "need more", amount: 5 })
  })

  test("a grant clears the ask; the turn is running again, not requesting", () => {
    const log = [
      ...base,
      { type: "BudgetRequested", callId: "rb1", reason: "need more", amount: 5, turn: "m1", at: 1 } as Envelope,
      { type: "BudgetGranted", amount: 5, turn: "m1", at: 2 } as Envelope
    ]
    expect(boundaryOf(log, "m1")).toBeUndefined()
  })

  test("a terminal wins over an earlier ask: a resumed turn that finished reads completed", () => {
    const log = [
      ...base,
      { type: "BudgetRequested", callId: "rb1", reason: "need more", amount: 5, turn: "m1", at: 1 } as Envelope,
      { type: "BudgetGranted", amount: 5, turn: "m1", at: 2 } as Envelope,
      { type: "TurnCompleted", output: "done", turn: "m1", at: 3 } as Envelope
    ]
    expect(boundaryOf(log, "m1")).toEqual({ kind: "completed", output: "done" })
  })

  test("a second ask after a grant is the pending boundary", () => {
    const log = [
      ...base,
      { type: "BudgetRequested", callId: "rb1", reason: "first", amount: 5, turn: "m1", at: 1 } as Envelope,
      { type: "BudgetGranted", amount: 5, turn: "m1", at: 2 } as Envelope,
      { type: "BudgetRequested", callId: "rb2", reason: "second", amount: 3, turn: "m1", at: 3 } as Envelope
    ]
    expect(boundaryOf(log, "m1")).toEqual({ kind: "requesting", callId: "rb2", reason: "second", amount: 3 })
  })
})
