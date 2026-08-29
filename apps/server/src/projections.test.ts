import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { replyId } from "@clavia/tardigrade-core/communication/message"
import { childCreated, threadCreated } from "@clavia/tardigrade-core/thread"

import { statusOf, summaryOf, treeOf } from "./projections"

// The projections are functions of an event array, so the fixtures are event arrays: the shapes
// below are the ones an assembled thread writes (packages/agent/src/index.test.ts and
// packages/code/src/execution/events.ts), trimmed to the fields a projection reads.

let clock = 0
const at = () => ++clock

const created = (id: string, parent?: string, depth = 0): Event =>
  threadCreated(
    { actor: "default", instance: "main", thread: id },
    parent === undefined ? undefined : { parent: { actor: "default", instance: "main", thread: parent }, depth },
    at()
  )

const spawned = (id: string, parent: string, depth: number): Event =>
  childCreated(
    `create-${id}`,
    { actor: "default", instance: "main", thread: id },
    { parent: { actor: "default", instance: "main", thread: parent }, depth },
    at()
  )

const inbound = (id: string, text = "do the thing"): Event =>
  ({ type: "MessageReceived", id, text, at: at() }) as Event

const dispatched = (execId: string): Event =>
  ({ type: "CodeDispatched", execId, code: "return 1", at: at() }) as Event

const called = (callId: string, name = "threads"): Event =>
  ({ type: "PackageCalled", callId, name, arguments: {}, at: at() }) as Event

const blocked = (callId: string, awaiting: string): Event =>
  ({ type: "BlockedOn", callId, awaiting, at: at() }) as Event

const settledCode = (execId: string): Event =>
  ({ type: "CodeSettled", execId, result: "ok", at: at() }) as Event

const completed = (turn: string, output: string): Event =>
  ({ type: "TurnCompleted", turn, output, at: at() }) as Event

const failed = (turn: string, error: string): Event =>
  ({ type: "TurnFailed", turn, error, at: at() }) as Event

const reply = (id: string, text = "done"): Event =>
  ({ type: "MessageReceived", id: replyId(id), text, outcome: "completed", at: at() }) as Event

describe("statusOf", () => {
  test("an empty log is settled", () => {
    expect(statusOf([])).toBe("settled")
  })

  test("a turn with a terminal is settled", () => {
    const log = [inbound("m1"), dispatched("t1"), settledCode("t1"), completed("m1", "42")]
    expect(statusOf(log)).toBe("settled")
  })

  test("a fresh turn is running", () => {
    expect(statusOf([inbound("m1")])).toBe("running")
  })

  test("an unsettled execution that can move is running", () => {
    expect(statusOf([inbound("m1"), dispatched("t1"), called("t1.0")])).toBe("running")
  })

  test("an open BlockedOn with the reply away is blocked", () => {
    const log = [inbound("m1"), dispatched("t1"), called("t1.0"), blocked("t1.0", replyId("t1.0"))]
    expect(statusOf(log)).toBe("blocked")
  })

  test("a landed reply unblocks the thread", () => {
    const log = [
      inbound("m1"),
      dispatched("t1"),
      called("t1.0"),
      blocked("t1.0", replyId("t1.0")),
      reply("t1.0")
    ]
    expect(statusOf(log)).toBe("running")
  })

  test("a failed last turn with nothing owed is failed", () => {
    const log = [inbound("m1"), dispatched("t1"), settledCode("t1"), failed("m1", "the tool exploded")]
    expect(statusOf(log)).toBe("failed")
  })

  test("a failed turn followed by a live one is running, not failed", () => {
    const log = [inbound("m1"), failed("m1", "boom"), inbound("m2")]
    expect(statusOf(log)).toBe("running")
  })
})

describe("summaryOf", () => {
  test("a summary counts events and carries the last timestamp", () => {
    const log = [created("root"), inbound("m1"), completed("m1", "42")]
    const summary = summaryOf("root", log)
    expect(summary.id).toBe("root")
    expect(summary.depth).toBe(0)
    expect(summary.events).toBe(3)
    expect(summary.lastAt).toBe(log[2]!["at"] as number)
    expect(summary.status).toBe("settled")
    expect("parent" in summary).toBe(false)
  })

  test("a summary carries the parent the caller supplies", () => {
    expect(summaryOf("t1.0", [created("t1.0", "root", 1)], "root")).toMatchObject({ parent: "root", depth: 1 })
  })

  test("a log without its creation record is rejected", () => {
    expect(() => summaryOf("root", [])).toThrow("no ThreadCreated first event")
  })
})

describe("treeOf", () => {
  // Two roots, and one of them three levels deep: root -> t1.0 -> t9.0.
  const forest = (): ReadonlyMap<string, ReadonlyArray<Event>> =>
    new Map<string, ReadonlyArray<Event>>([
      ["root", [created("root"), inbound("m1"), dispatched("t1"), called("t1.0"), spawned("t1.0", "root", 1), called("t1.1"), spawned("t1.1", "root", 1)]],
      ["t1.0", [created("t1.0", "root", 1), inbound("t1.0"), dispatched("t9"), called("t9.0"), spawned("t9.0", "t1.0", 2)]],
      ["t1.1", [created("t1.1", "root", 1), inbound("t1.1")]],
      ["t9.0", [created("t9.0", "t1.0", 2), inbound("t9.0")]],
      ["other", [created("other"), inbound("m2")]]
    ])

  test("three levels, two roots", () => {
    const roots = treeOf(forest())
    expect(roots.map((node) => node.id)).toEqual(["root", "other"])
    const root = roots[0]!
    expect(root.children.map((node) => node.id)).toEqual(["t1.0", "t1.1"])
    expect(root.children[0]!.children.map((node) => node.id)).toEqual(["t9.0"])
    expect(root.children[0]!.children[0]!.children).toEqual([])
    expect(roots[1]!.children).toEqual([])
  })

  test("every node carries its own summary, and a child names its parent", () => {
    const root = treeOf(forest())[0]!
    expect(root.status).toBe("running")
    const child = root.children[0]!
    expect(child.parent).toBe("root")
    expect(child.depth).toBe(1)
    expect(child.events).toBe(5)
    expect(root.children[0]!.children[0]!.parent).toBe("t1.0")
    expect("parent" in root).toBe(false)
  })

  test("a package call to a non-thread claims nothing", () => {
    const logs = new Map<string, ReadonlyArray<Event>>([
      ["root", [created("root"), inbound("m1"), dispatched("t1"), called("t1.0", "workspace")]]
    ])
    expect(treeOf(logs).map((node) => node.id)).toEqual(["root"])
  })

  test("roots sort by first event time", () => {
    const early = [created("early"), inbound("a")]
    const late = [created("late"), inbound("b")]
    const logs = new Map<string, ReadonlyArray<Event>>([["late", late], ["early", early]])
    expect(treeOf(logs).map((node) => node.id)).toEqual(["early", "late"])
  })
})
