import { describe, expect, test } from "bun:test"
import type { ActorThread } from "@clavia/tardigrade-client"
import { applyActorEvent } from "./threads"

const thread = (id: string): ActorThread => ({
  id,
  depth: 0
})

describe("actor threads", () => {
  test("a snapshot replaces the threads", () => {
    expect(applyActorEvent([thread("old")], {
      type: "ThreadsSnapshot",
      threads: [thread("current")]
    })).toEqual([thread("current")])
  })

  test("an added thread joins the listing", () => {
    expect(applyActorEvent([thread("a"), thread("b")], {
      type: "ThreadAdded",
      thread: thread("c")
    })).toEqual([thread("a"), thread("b"), thread("c")])
  })

  test("a replayed addition changes nothing", () => {
    const current = [thread("a")]
    expect(applyActorEvent(current, { type: "ThreadAdded", thread: thread("a") })).toBe(current)
  })
})
