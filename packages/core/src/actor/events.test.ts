import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorEventKeyOf, actorThreadsOf } from "./events"

describe("actor events", () => {
  test("allocation and registration project into the same thread record", () => {
    const allocated: Event = { type: "ThreadAllocated", thread: "quiet-fox-abcd", allocationKey: "spawn", parentThread: "main", depth: 1, at: 0 }
    const requested: Event = { type: "ThreadRequested", thread: "quiet-fox-abcd", parentThread: "main", depth: 1, placement: "independent", at: 1 }
    const registered: Event = { type: "ThreadRegistered", thread: "quiet-fox-abcd", at: 2 }
    for (const [events, state] of [
      [[allocated], "allocated"], [[allocated, requested], "requested"], [[allocated, requested, registered], "registered"]
    ] as const) {
      expect(actorThreadsOf(events)).toEqual([expect.objectContaining({ allocationKey: "spawn", thread: "quiet-fox-abcd", parentThread: "main", depth: 1, state })])
    }
    expect(actorEventKeyOf(allocated)).toBe("thread:allocated:quiet-fox-abcd")
  })

  test("projects thread registration", () => {
    const events: ReadonlyArray<Event> = [
      { type: "ThreadRequested", thread: "child", parentThread: "root", depth: 1, at: 1 },
      { type: "ThreadRegistered", thread: "child", at: 2 }
    ]
    expect(actorThreadsOf(events)).toEqual([{
      thread: "child",
      parentThread: "root",
      depth: 1,
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
