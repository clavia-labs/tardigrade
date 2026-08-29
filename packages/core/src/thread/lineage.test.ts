import { describe, expect, test } from "bun:test"
import type { Event } from "../log/event"
import { childCreated, childLineageOf, isThreadCreated, sameThreadLineage, threadCreated, threadCreatedOf, threadKeys } from "./lineage"

describe("thread creation", () => {
  test("a root records depth zero and no parent", () => {
    const created = threadCreated({ actor: "agent", instance: "main", thread: "root" }, undefined, 11)
    expect(created).toEqual({
      type: "ThreadCreated",
      address: { actor: "agent", instance: "main", thread: "root" },
      depth: 0,
      at: 11
    })
    expect(isThreadCreated(created)).toBe(true)
    expect(threadKeys.keyOf(created)).toBe("thread:created")
  })

  test("a child derives its parent and next depth from durable creation", () => {
    const root = threadCreated({ actor: "agent", instance: "main", thread: "root" }, undefined, 1)
    const lineage = childLineageOf(root)
    const child = threadCreated({ actor: "agent", instance: "main", thread: "child" }, lineage, 2)
    expect(lineage).toEqual({ parent: root.address, depth: 1 })
    expect(sameThreadLineage(child, lineage)).toBe(true)
  })

  test("a parent keys child creation by its call occurrence", () => {
    const root = threadCreated({ actor: "agent", instance: "main", thread: "root" }, undefined, 1)
    const created = childCreated("call-1", { actor: "agent", instance: "main", thread: "child" }, childLineageOf(root), 2)
    expect(threadKeys.keyOf(created)).toBe("thread:child:call-1")
  })

  test("a child records requested placement", () => {
    const root = threadCreated({ actor: "agent", instance: "main", thread: "root" }, undefined, 1)
    const lineage = childLineageOf(root, "independent")
    const child = threadCreated({ actor: "agent", instance: "main", thread: "child" }, lineage, 2)
    expect(lineage.placement).toBe("independent")
    expect(child.placement).toBe("independent")
    expect(isThreadCreated(child)).toBe(true)
    expect(sameThreadLineage(child, childLineageOf(root, "colocated"))).toBe(false)
  })

  test("identity is read only from the first log position", () => {
    const created = threadCreated({ actor: "agent", instance: "main", thread: "late" }, undefined, 2)
    const events = [{ type: "MessageReceived", id: "m1", at: 1 } as Event, created]
    expect(threadCreatedOf(events)).toBeUndefined()
  })

  test("invalid depth and time are refused", () => {
    expect(isThreadCreated({ type: "ThreadCreated", address: { actor: "agent", instance: "main", thread: "x" }, depth: -1, at: 1 } as Event)).toBe(false)
    expect(isThreadCreated({ type: "ThreadCreated", address: { actor: "agent", instance: "main", thread: "x" }, depth: 0, at: Number.NaN } as Event)).toBe(false)
  })
})
