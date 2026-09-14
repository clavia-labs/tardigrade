import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { childCreated, childInvocationsOf, childLineageOf, invocationLinked, isInvocationLinked, isThreadCreated, openChildInvocationsOf, sameThreadLineage, threadCreated, threadCreatedForDelivery, threadCreatedOf, threadKeys } from "./relations"
import { formatThreadAddress } from "../transport/endpoint"

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
    expect(threadKeys.keyOf({ type: "ThreadForked", source: { actor: "agent", instance: "main", thread: "root" }, at: 40 })).toBe("thread:forked")
  })

  test("invalid depth and time are refused", () => {
    expect(isThreadCreated({ type: "ThreadCreated", address: { actor: "agent", instance: "main", thread: "x" }, depth: -1, at: 1 } as Event)).toBe(false)
    expect(isThreadCreated({ type: "ThreadCreated", address: { actor: "agent", instance: "main", thread: "x" }, depth: 0, at: Number.NaN } as Event)).toBe(false)
  })
})

describe("child invocations", () => {
  const worker1 = formatThreadAddress({ actor: "agent", instance: "main", thread: "worker-1" })
  const worker2 = formatThreadAddress({ actor: "agent", instance: "main", thread: "worker-2" })
  const worker9 = formatThreadAddress({ actor: "agent", instance: "main", thread: "worker-9" })
  const parent = { method: "message", id: "m1", epoch: 0 }
  const first = invocationLinked({ parent, child: { invocation: { method: "message", id: "c1", epoch: 0 } }, target: worker1, at: 2 })
  const second = invocationLinked({ parent, child: { invocation: { method: "message", id: "c2", epoch: 0 } }, target: worker2, at: 3 })
  const firstSettled = { type: "ResponseReceived", id: "c1.reply", from: worker1, method: "message", call: "c1", status: "completed", at: 4 } as Event
  const secondTimedOut = { type: "CallTimedOut", target: worker2, method: "message", call: "c2", timeoutMs: 10, deadlineAt: 13, at: 14 } as Event

  test("creation is the edge and settlement is a terminal for the edge's coordinate", () => {
    const events = [first, second]
    expect(childInvocationsOf(events)).toEqual([first, second])
    expect(openChildInvocationsOf(events)).toEqual([first, second])
    expect(openChildInvocationsOf([...events, firstSettled])).toEqual([second])
    expect(openChildInvocationsOf([...events, firstSettled, secondTimedOut])).toEqual([])
  })

  test("a terminal for another coordinate settles nothing", () => {
    const otherCall = { ...firstSettled, call: "c9" } as Event
    const otherThread = { ...firstSettled, from: worker9 } as Event
    const otherEpoch = { ...firstSettled, epoch: 1 } as Event
    expect(openChildInvocationsOf([first, otherCall, otherThread, otherEpoch])).toEqual([first])
  })

  test("a malformed edge is not a child invocation", () => {
    expect(isInvocationLinked({ type: "InvocationLinked", target: "[not, an, address", child: { invocation: parent }, at: 1 } as Event)).toBe(false)
    expect(isInvocationLinked({ type: "InvocationLinked", target: worker1, at: 1 } as Event)).toBe(false)
    expect(isInvocationLinked(first)).toBe(true)
  })
})
