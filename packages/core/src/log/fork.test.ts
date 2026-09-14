import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { invocationLinked, threadCreated } from "../interaction/relations"
import { formatThreadAddress } from "../transport/endpoint"
import { checkpointSeqOf, forkBatchOf, isThreadForked, matchingFork, prefixOf, threadForked } from "./fork"

const root = { actor: "agent", instance: "main", thread: "root" } as const
const created = threadCreated(root, undefined, 1)
const first = { type: "MessageReceived", id: "m1", text: "one", at: 2 } as Event
const second = { type: "MessageReceived", id: "m2", text: "two", at: 3 } as Event
const source = [created, first, second]
const worker1 = formatThreadAddress({ ...root, thread: "worker-1" })
const destCreated = threadCreated({ ...root, thread: "experiment" }, undefined, 10)

describe("prefixOf", () => {
  test("a seq copies rows 1 through seq", () => {
    expect(prefixOf(source, 1)).toEqual([created])
    expect(prefixOf(source, 2)).toEqual([created, first])
    expect(prefixOf(source, 3)).toEqual(source)
  })

  test("a seq outside the log is refused", () => {
    for (const seq of [0, -1, 1.5, 4, Number.NaN]) {
      expect(() => prefixOf(source, seq)).toThrow("outside the log (1..3)")
    }
  })
})

describe("checkpointSeqOf", () => {
  test("a row passes through and an event id names its last matching row", () => {
    const called = { type: "ModelCalled", callId: "c1", at: 4 } as Event
    const returned = { type: "ModelReturned", callId: "c1", at: 5 } as Event
    const log = [created, first, second, called, returned]
    expect(checkpointSeqOf(log, { seq: 3 })).toBe(3)
    expect(checkpointSeqOf(log, { event: "m1" })).toBe(2)
    expect(checkpointSeqOf(log, { event: "c1" })).toBe(5)
    expect(() => checkpointSeqOf(log, { event: "ghost" })).toThrow('no event with id "ghost"')
  })
})

describe("forkBatchOf", () => {
  test("the batch drops the source identity and ends with the fork fact", () => {
    const batch = forkBatchOf(source, 2, root, "experiment", 40)
    expect(batch).toEqual([first, { type: "ThreadForked", source: root, destination: "experiment", at: 40 }])
    expect(isThreadForked(batch.at(-1))).toBe(true)
  })

  test("the fork fact position is the boundary", () => {
    const batch = forkBatchOf(source, 3, root, "experiment", 40)
    const dest = [destCreated, ...batch]
    const marker = dest.findIndex(isThreadForked)
    expect(marker).toBe(3)
    expect(dest.slice(1, marker)).toEqual([first, second])
  })

  test("a prefix detaches pending child invocations and preserves received responses", () => {
    const linked = invocationLinked({
      parent: { method: "message", id: "m1", epoch: 0 },
      child: { invocation: { method: "message", id: "c1", epoch: 0 } },
      target: worker1,
      at: 3
    })
    const settled = {
      type: "ResponseReceived", id: "c1.reply", from: worker1, method: "message", call: "c1", status: "completed", at: 4
    } as Event
    const withOpen = [created, first, linked]
    expect(forkBatchOf(withOpen, 3, root, "experiment", 40).at(-1)).toMatchObject({
      type: "InvocationDetached", direction: "outgoing",
      reference: { target: { ...root, thread: "worker-1" }, invocation: linked.child.invocation }
    })
    expect(forkBatchOf([...withOpen, settled], 4, root, "experiment", 40).map((event) => event.type)).toEqual([
      "MessageReceived", "InvocationLinked", "ResponseReceived", "ThreadForked"
    ])
    expect(forkBatchOf(withOpen, 2, root, "experiment", 40).map((event) => event.type)).toEqual(["MessageReceived", "ThreadForked"])
  })

  test("a source without a leading ThreadCreated is copied whole", () => {
    expect(forkBatchOf([first, second], 2, root, "experiment", 40).map((event) => event.type)).toEqual([
      "MessageReceived", "MessageReceived", "ThreadForked"
    ])
  })
})

describe("matchingFork", () => {
  test("a destination holding the same batch matches, another source or length does not", () => {
    const batch = forkBatchOf(source, 2, root, "experiment", 40)
    expect(matchingFork([destCreated, ...batch], batch)).toBe(true)
    expect(matchingFork([destCreated, ...batch], forkBatchOf(source, 3, root, "experiment", 40))).toBe(false)
    expect(matchingFork([destCreated, ...forkBatchOf(source, 2, { ...root, thread: "other" }, "experiment", 40)], batch)).toBe(false)
    expect(matchingFork([destCreated], batch)).toBe(false)
    expect(matchingFork([destCreated, first], batch)).toBe(false)
  })
})

describe("isThreadForked", () => {
  test("a stored row with a string source is not a fork fact", () => {
    expect(isThreadForked({ type: "ThreadForked", source: "root", at: 1 } as Event)).toBe(false)
    expect(isThreadForked(threadForked({ source: root, destination: "experiment", at: 1 }))).toBe(true)
  })
})

test("fork publication detaches an unlinked planned call before it can dispatch", () => {
  const reference = { target: { ...root, thread: "worker" }, invocation: { method: "work", id: "pending", epoch: 0 } }
  const planned: Event = { type: "CallPlanned", reference, id: "pending", method: "work", target: formatThreadAddress(reference.target),
    context: { invocation: reference.invocation }, input: {}, timeoutMs: 100, at: 1 }
  const batch = forkBatchOf([created, planned], 2, root, "experiment", 2)
  expect(batch.at(-1)).toEqual({ type: "InvocationDetached", direction: "outgoing", reference, at: 2 })
  expect(matchingFork([destCreated, ...batch], batch)).toBe(true)
  expect(matchingFork([destCreated, ...batch], forkBatchOf([created, planned], 2, root, "other", 3))).toBe(false)
})

test("fork publication refuses a legacy reply link without an invocation identity", () => {
  const accepted: Event = { type: "Asked", id: "legacy", link: { source: { ...root, thread: "caller" }, target: root }, at: 1 }
  expect(() => forkBatchOf([created, accepted], 2, root, "experiment", 2)).toThrow("without an invocation identity")
})
