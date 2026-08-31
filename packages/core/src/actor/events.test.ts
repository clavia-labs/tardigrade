import { describe, expect, test } from "bun:test"
import type { Event } from "../log/event"
import { actorEventKeyOf, actorThreadsOf } from "./events"

describe("actor events", () => {
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

  test("keys every durable actor occurrence", () => {
    expect(actorEventKeyOf({ type: "ThreadRequested", thread: "root" })).toBe("thread:requested:root")
    expect(actorEventKeyOf({ type: "ThreadRegistered", thread: "root" })).toBe("thread:registered:root")
  })
})
