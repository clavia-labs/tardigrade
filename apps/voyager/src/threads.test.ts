import { describe, expect, test } from "bun:test"
import type { ThreadSummary } from "@clavia/tardigrade-client"
import { applyActorEvent } from "./threads"

const thread = (id: string, status: ThreadSummary["status"]): ThreadSummary => ({
  id,
  depth: 0,
  events: 1,
  status
})

describe("actor threads", () => {
  test("a snapshot replaces the threads", () => {
    expect(applyActorEvent([thread("old", "settled")], {
      type: "ThreadsSnapshot",
      threads: [thread("current", "running")]
    })).toEqual([thread("current", "running")])
  })

  test("a change updates one thread in place", () => {
    expect(applyActorEvent([thread("a", "settled"), thread("b", "running")], {
      type: "ThreadChanged",
      thread: thread("a", "failed")
    })).toEqual([thread("a", "failed"), thread("b", "running")])
  })
})
