import { describe, expect, test } from "bun:test"
import type { Event, EventRow } from "@clavia/tardigrade-client"

import { activeMessageCall, childThread, pendingChildCount, waitingForResponse } from "./events"

const row = (seq: number, event: Event): EventRow => ({ seq, event })

describe("childThread", () => {
  test("uses the recorded child address", () => {
    const event = {
      type: "ChildCreated",
      callId: "call-1",
      address: { actor: "react-chat", instance: "main", thread: "ag.6:turn-1call-1" }
    } as Event

    expect(childThread(event)).toBe("6:turn-1call-1")
  })

  test("does not treat a call id as a child thread", () => {
    expect(childThread({ type: "ChildCreated", callId: "call-1" } as Event)).toBeUndefined()
  })
})

describe("waitingForResponse", () => {
  test("stops waiting when a turn is cancelled", () => {
    const events = [
      { seq: 1, event: { type: "ModelCalled" } as Event },
      { seq: 2, event: { type: "TurnCancelled" } as Event }
    ] as ReadonlyArray<EventRow>

    expect(waitingForResponse(events)).toBe(false)
  })
})

describe("activeMessageCall", () => {
  test("returns the durable message call that has no terminal", () => {
    const events = [row(1, {
      type: "MessageReceived",
      id: "turn-1",
      call: { invocation: { method: "message", id: "turn-1", epoch: 0 }, deadlineAt: 10 }
    } as Event)]

    expect(activeMessageCall(events)).toBe("turn-1")
  })

  test("a cancellation closes the call", () => {
    const events = [
      row(1, {
        type: "MessageReceived",
        id: "turn-1",
        call: { invocation: { method: "message", id: "turn-1", epoch: 0 }, deadlineAt: 10 }
      } as Event),
      row(2, { type: "TurnCancelled", turn: "turn-1" } as Event)
    ]

    expect(activeMessageCall(events)).toBeUndefined()
  })

  test("a completion closes the call", () => {
    const events = [
      row(1, {
        type: "MessageReceived",
        id: "turn-1",
        call: { invocation: { method: "message", id: "turn-1", epoch: 0 }, deadlineAt: 10 }
      } as Event),
      row(2, { type: "TurnCompleted", turn: "turn-1", output: "done" } as Event)
    ]

    expect(activeMessageCall(events)).toBeUndefined()
  })
})

describe("pendingChildCount", () => {
  const children = [row(1, {
    type: "ChildCreated",
    callId: "child-1",
    address: { actor: "react-rlm-chat", instance: "main", thread: "ag.child-1" }
  } as Event)]

  test("a child response settles the card", () => {
    expect(pendingChildCount(children, [
      ...children,
      row(2, { type: "ResponseReceived", call: "child-1", status: "completed" } as Event)
    ])).toBe(0)
  })

  test("a package failure settles the card", () => {
    expect(pendingChildCount(children, [
      ...children,
      row(2, { type: "PackageReturned", callId: "child-1", result: { error: "failed" } } as Event)
    ])).toBe(0)
  })
})
