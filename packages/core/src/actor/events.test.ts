import { describe, expect, test } from "bun:test"
import type { Event } from "../log/event"
import { actorEventKeyOf, actorThreadsOf } from "./events"

describe("actor events", () => {
  test("projects creation and committed heads", () => {
    const events: ReadonlyArray<Event> = [
      { type: "ThreadRequested", thread: "child", parentThread: "root", depth: 1, at: 1 },
      { type: "ThreadCreated", thread: "child", at: 2 },
      { type: "ThreadCommitted", thread: "child", head: 4, at: 3 }
    ]
    expect(actorThreadsOf(events)).toEqual([{
      thread: "child",
      parentThread: "root",
      depth: 1,
      state: "created",
      head: 4
    }])
  })

  test("keeps a commit delivered before its request", () => {
    expect(actorThreadsOf([
      { type: "ThreadCommitted", thread: "root", head: 2, at: 1 },
      { type: "ThreadRequested", thread: "root", depth: 0, at: 2 },
      { type: "ThreadCreated", thread: "root", at: 3 }
    ])).toEqual([{ thread: "root", depth: 0, state: "created", head: 2 }])
  })

  test("keys every durable actor occurrence", () => {
    expect(actorEventKeyOf({ type: "ThreadCommitted", thread: "root", head: 3 })).toBe("thread:committed:root:3")
    expect(actorEventKeyOf({ type: "ThreadCommitted", thread: "root", after: 2, head: 3 })).toBe("thread:committed:root:2")
  })
})
