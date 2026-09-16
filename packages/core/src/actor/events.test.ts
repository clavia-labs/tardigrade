import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorEventKeyOf, actorThreadsOf } from "./events"
import { childKeyOf } from "./coordinate"

describe("actor events", () => {
  test("derives directory lineage from creation requests across replay", () => {
    const root = { actor: "test", instance: "main", thread: "root" }
    const child = { ...root, thread: "child" }
    const events: Event[] = [
      { type: "ThreadRequested", thread: root.thread, allocationRequest: { kind: "root", coordinate: root }, at: 0 },
      { type: "ThreadRegistered", thread: root.thread, at: 1 },
      { type: "ThreadRequested", thread: child.thread, allocationRequest: { kind: "child", parent: root, child: childKeyOf(child.thread), placement: "colocated" }, at: 2 },
      { type: "ThreadRegistered", thread: child.thread, placement: "independent", at: 3 },
      { type: "ThreadRequested", thread: "grandchild", allocationRequest: { kind: "child", parent: child, child: childKeyOf("grandchild"), placement: "colocated" }, at: 4 }
    ]
    const expected = [
      expect.objectContaining({ thread: "root", depth: 0, state: "registered" }),
      expect.objectContaining({ thread: "child", parentThread: "root", depth: 1, placement: "independent", state: "registered" }),
      expect.objectContaining({ thread: "grandchild", parentThread: "child", depth: 2, placement: "colocated", state: "requested" })
    ]
    expect(actorThreadsOf(events)).toEqual(expected)
    expect(actorThreadsOf(JSON.parse(JSON.stringify(events)))).toEqual(expected)
    expect(actorThreadsOf(events.slice(0, 3))[1]).toMatchObject({ parentThread: "root", depth: 1, placement: "colocated", state: "requested" })
  })

  test("refuses to infer child depth without a parent record", () => {
    const parent = { actor: "test", instance: "main", thread: "missing" }
    expect(() => actorThreadsOf([
      { type: "ThreadRequested", thread: "child", allocationRequest: { kind: "child", parent, child: childKeyOf("child") }, at: 0 }
    ])).toThrow('has no parent record "missing"')
  })

  test("allocation and registration project into the same thread record", () => {
    const requested: Event = { type: "ThreadRequested", thread: "quiet-fox-abcd", allocationKey: "spawn", parentThread: "main", depth: 1, at: 1 }
    const registered: Event = { type: "ThreadRegistered", thread: "quiet-fox-abcd", placement: "independent", at: 2 }
    for (const [events, state] of [
      [[requested], "requested"], [[requested, registered], "registered"]
    ] as const) {
      expect(actorThreadsOf(events)).toEqual([expect.objectContaining({ allocationKey: "spawn", thread: "quiet-fox-abcd", parentThread: "main", depth: 1, state })])
    }
    expect(actorThreadsOf([requested, registered])[0]?.placement).toBe("independent")
    expect(actorEventKeyOf(requested)).toBe("thread:requested:quiet-fox-abcd")
  })

  test("replays lineage from older request events", () => {
    const events: ReadonlyArray<Event> = [
      { type: "ThreadRequested", thread: "child", parentThread: "root", depth: 1, placement: "independent", at: 1 },
      { type: "ThreadRegistered", thread: "child", at: 2 }
    ]
    expect(actorThreadsOf(events)).toEqual([{
      thread: "child",
      parentThread: "root",
      depth: 1,
      placement: "independent",
      state: "registered"
    }])
  })

  test("keeps request order", () => {
    const events: ReadonlyArray<Event> = [
      { type: "ThreadRequested", thread: "zebra", depth: 0, at: 1 },
      { type: "ThreadRegistered", thread: "zebra", at: 2 },
      { type: "ThreadRequested", thread: "alpha", depth: 0, at: 3 },
      { type: "ThreadRegistered", thread: "alpha", at: 4 }
    ]
    expect(actorThreadsOf(events).map((thread) => thread.thread)).toEqual(["zebra", "alpha"])
  })

  test("keys every durable actor occurrence", () => {
    expect(actorEventKeyOf({ type: "ThreadRequested", thread: "root" })).toBe("thread:requested:root")
    expect(actorEventKeyOf({ type: "ThreadRegistered", thread: "root" })).toBe("thread:registered:root")
  })
})
