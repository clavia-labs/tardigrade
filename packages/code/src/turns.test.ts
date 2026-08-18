import { describe, expect, test } from "bun:test"
import type { Event } from "@flamecast/core/event"
import { turnHead } from "./turns"

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
