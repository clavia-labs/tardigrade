import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorEventKeyOf, actorThreadsOf } from "./events"

describe("actor events", () => {
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

  test("legacy allocations retain their identity and registration metadata", () => {
    const allocated: Event = { type: "ThreadAllocated", thread: "old-child", allocationKey: "spawn", parentThread: "main", depth: 1, at: 0 }
    const requested: Event = { type: "ThreadRequested", thread: "old-child", parentThread: "main", depth: 1, placement: "independent", at: 1 }
    const registered: Event = { type: "ThreadRegistered", thread: "old-child", at: 2 }
    expect(actorThreadsOf([allocated])[0]).toMatchObject({ allocationKey: "spawn", state: "requested" })
    for (const events of [[allocated, requested, registered], [requested, registered, allocated]]) {
      expect(actorThreadsOf(events)).toEqual([{
        allocationKey: "spawn", thread: "old-child", parentThread: "main", depth: 1, placement: "independent", state: "registered"
      }])
    }
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
