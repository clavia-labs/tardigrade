import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { trajectoryOf, turnEpochOf, turnHead, turnTerminalOf, turnView } from "./turns"

// `heads()` (private to this module) is what `turnHead`/`turnView` fold over: every
// `MessageReceived`, except a reply a package call was still parked on when it landed. That
// exclusion is what stops a foreground `agents.run`/`tasks.fire` park from also spawning a ghost
// turn once its outer turn completes and the reply row is still sitting on the log, unconsumed by
// anything turnHead itself understands. A background spawn's reply is the opposite case: the call
// that fired it has already returned by the time the reply lands, so it is NOT excluded, and
// heads its own turn exactly as `agents.run({background:true})`/`tasks.fire({background:true})`
// promise.

describe("turnHead: a reply claimed by a still-open package call", () => {
  test("is excluded: it never heads a turn on its own", () => {
    const log: ReadonlyArray<Event> = [
      { type: "PackageCalled", callId: "c1", name: "agents.run", arguments: {}, turn: "m1", at: 1 },
      { type: "MessageReceived", id: "c1.reply", outcome: "completed", text: "4", from: "child", at: 2 }
    ]
    expect(turnHead(log)).toBeUndefined()
  })

  test("a reply for a call that had already returned is not excluded: it heads its own turn", () => {
    const log: ReadonlyArray<Event> = [
      { type: "PackageCalled", callId: "c1", name: "agents.run", arguments: {}, turn: "m1", at: 1 },
      { type: "PackageReturned", callId: "c1", result: { dispatched: true }, turn: "m1", at: 2 },
      { type: "MessageReceived", id: "c1.reply", outcome: "completed", text: "4", from: "child", at: 3 }
    ]
    const head = turnHead(log)
    expect(head).toMatchObject({ id: "c1.reply" })
  })

  test("an ordinary inbound with no matching PackageCalled is unaffected", () => {
    const log: ReadonlyArray<Event> = [{ type: "MessageReceived", id: "m1", text: "hello", at: 1 }]
    expect(turnHead(log)).toMatchObject({ id: "m1" })
  })

  test("a reply id from a different package's minted scheme (run-prefixed) is unaffected", () => {
    // `tasks.fire` mints `run-<callId>` (`mintedRunId`), never the bare call id, so its own
    // reply's id never matches a `PackageCalled.callId` verbatim: this predicate structurally
    // never claims it, whatever the call's own open/closed state.
    const log: ReadonlyArray<Event> = [
      { type: "PackageCalled", callId: "c1", name: "tasks.fire", arguments: {}, turn: "m1", at: 1 },
      { type: "MessageReceived", id: "run-c1.reply", outcome: "completed", text: "done", from: "child", at: 2 }
    ]
    const head = turnHead(log)
    expect(head).toMatchObject({ id: "run-c1.reply" })
  })
})

describe("a resumed turn", () => {
  const failed: ReadonlyArray<Event> = [
    { type: "MessageReceived", id: "m1", text: "read", at: 1 },
    { type: "ModelCalled", callId: "m1/infer/0", ordinal: 0, turn: "m1", at: 2 },
    { type: "ToolCalled", callId: "c1", name: "read", arguments: {}, turn: "m1", at: 3 },
    { type: "ToolReturned", callId: "c1", result: "contents", turn: "m1", at: 4 },
    { type: "ModelCalled", callId: "m1/infer/1", ordinal: 1, turn: "m1", at: 5 },
    { type: "TurnFailed", error: "timeout", turn: "m1", at: 6 }
  ]

  test("the retry request opens the next epoch over the committed history", () => {
    const log: ReadonlyArray<Event> = [
      ...failed,
      { type: "TurnResumed", turn: "m1", failedEpoch: 0, epoch: 1, at: 8 }
    ]

    expect(turnEpochOf(log, "m1")).toBe(1)
    expect(turnHead(log)).toMatchObject({ id: "m1" })
    expect(turnTerminalOf(log, "m1")).toBeUndefined()
    expect(turnView(log).filter((event) => event.type === "ToolReturned")).toHaveLength(1)
    expect(trajectoryOf(log).some((event) => event.type === "TurnFailed")).toBe(false)
  })

  test("the new epoch owns its terminal without redelivering the turn", () => {
    const completed: ReadonlyArray<Event> = [
      ...failed,
      { type: "TurnResumed", turn: "m1", failedEpoch: 0, epoch: 1, at: 8 },
      { type: "TurnCompleted", output: "done", turn: "m1", epoch: 1, at: 9 }
    ]

    expect(turnHead(completed)).toBeUndefined()
    expect(turnTerminalOf(completed, "m1")).toMatchObject({ type: "TurnCompleted", output: "done" })
  })
})
