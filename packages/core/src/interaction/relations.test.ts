import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { childCreated, childLineageOf, isThreadCreated, sameThreadLineage, threadCreated, threadCreatedForDelivery, threadCreatedOf, threadKeys } from "./relations"

describe("thread creation", () => {
  test("depth ceilings survive creation and cannot change on redelivery", () => {
    const root = { ...threadCreated({ actor: "agent", instance: "main", thread: "root" }, undefined, 1), maxDepth: 2 }
    const lineage = childLineageOf(root)
    const child = threadCreated({ ...root.address, thread: "child" }, lineage, 2)
    expect(child).toMatchObject({ depth: 1, maxDepth: 2 })
    expect(childCreated("call", child.address, lineage, 2)).toMatchObject({ depth: 1, maxDepth: 2 })
    expect(threadCreatedForDelivery([child], child.address, lineage, root.address)).toEqual(child)
    for (const maxDepth of [undefined, 1, 3]) {
      expect(() => threadCreatedForDelivery([child], child.address, { parent: root.address, depth: 1, ...(maxDepth === undefined ? {} : { maxDepth }) }, root.address))
        .toThrow("already has different lineage")
    }
  })

  test("invalid ceilings and child depths beyond the ceiling are rejected", () => {
    const root = threadCreated({ actor: "agent", instance: "main", thread: "root" }, undefined, 1)
    const target = { ...root.address, thread: "child" }
    for (const maxDepth of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isThreadCreated({ ...root, maxDepth })).toBe(false)
      expect(() => threadCreatedForDelivery([], target, { parent: root.address, depth: 1, maxDepth }, root.address))
        .toThrow("invalid child lineage")
    }
    expect(() => threadCreatedForDelivery([], target, { parent: root.address, depth: 3, maxDepth: 2 }, root.address))
      .toThrow("invalid child lineage")
  })

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

  test("a child key pairs the parent run with the call", () => {
    const root = threadCreated({ actor: "agent", instance: "main", thread: "root" }, undefined, 1)
    const lineage = childLineageOf(root)
    const first = childCreated("call-1", { actor: "agent", instance: "main", thread: "left" }, lineage, 2, "run-a")
    const second = childCreated("call-1", { actor: "agent", instance: "main", thread: "right" }, lineage, 3, "run-b")
    // Two runs reusing one call id record two children, so neither key absorbs the other.
    expect(threadKeys.keyOf(first)).not.toBe(threadKeys.keyOf(second))
    expect(threadKeys.keyOf(first)).toBe(`thread:child:${JSON.stringify(["run-a", "call-1"])}`)
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

  test("a fork fact keys once per destination log", () => {
    expect(threadKeys.keyOf({ type: "ThreadForked", sourceThread: "root", until: 2, forkedAt: 40 })).toBe("thread:forked")
  })

  test("invalid depth and time are refused", () => {
    expect(isThreadCreated({ type: "ThreadCreated", address: { actor: "agent", instance: "main", thread: "x" }, depth: -1, at: 1 } as Event)).toBe(false)
    expect(isThreadCreated({ type: "ThreadCreated", address: { actor: "agent", instance: "main", thread: "x" }, depth: 0, at: Number.NaN } as Event)).toBe(false)
  })
})
