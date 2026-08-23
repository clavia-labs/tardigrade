import { describe, expect, test } from "bun:test"
import type { Event } from "./event"
import { childLineageOf, isThreadCreated, sameThreadLineage, threadCreated, threadCreatedOf, threadKeys } from "./thread"

describe("thread creation", () => {
  test("a root records depth zero and no parent", () => {
    const created = threadCreated({ actor: "agent", thread: "root" }, undefined, 11)
    expect(created).toEqual({
      type: "ThreadCreated",
      address: { actor: "agent", thread: "root" },
      depth: 0,
      at: 11
    })
    expect(isThreadCreated(created)).toBe(true)
    expect(threadKeys.keyOf(created)).toBe("thread:created")
  })

  test("a child derives its parent and next depth from durable creation", () => {
    const root = threadCreated({ actor: "agent", thread: "root" }, undefined, 1)
    const lineage = childLineageOf(root)
    const child = threadCreated({ actor: "agent", thread: "child" }, lineage, 2)
    expect(lineage).toEqual({ parent: root.address, depth: 1 })
    expect(sameThreadLineage(child, lineage)).toBe(true)
  })

  test("identity is read only from the first log position", () => {
    const created = threadCreated({ actor: "agent", thread: "late" }, undefined, 2)
    const events = [{ type: "MessageReceived", id: "m1", at: 1 } as Event, created]
    expect(threadCreatedOf(events)).toBeUndefined()
  })

  test("invalid depth and time are refused", () => {
    expect(isThreadCreated({ type: "ThreadCreated", address: { actor: "agent", thread: "x" }, depth: -1, at: 1 } as Event)).toBe(false)
    expect(isThreadCreated({ type: "ThreadCreated", address: { actor: "agent", thread: "x" }, depth: 0, at: Number.NaN } as Event)).toBe(false)
  })
})
