import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { threadCreated } from "../interaction/relations"
import type { AppendResult, ThreadEventStore } from "./service"
import {
  copyPrefix,
  eventIdentityOf,
  forkBatchOf,
  forkUntilOf,
  matchingFork,
  prefixUntil,
  threadForked
} from "./fork"

const created = threadCreated({ actor: "agent", instance: "main", thread: "root" }, undefined, 1)
const first = { type: "MessageReceived", id: "m1", text: "one", at: 2 } as Event
const second = { type: "MessageReceived", id: "m2", text: "two", at: 3 } as Event
const source = [created, first, second]

const memoryStore = (): ThreadEventStore & { readonly writes: Array<ReadonlyArray<Event>> } => {
  let events: Event[] = []
  const writes: Array<ReadonlyArray<Event>> = []
  const append = (batch: ReadonlyArray<Event>) => Effect.sync((): AppendResult => {
    writes.push(batch)
    events = [...events, ...batch]
    return { appended: batch.length, head: events.length }
  })
  return {
    append,
    copyPrefix: append,
    read: Effect.sync(() => events),
    head: Effect.sync(() => events.length),
    readFrom: (mark) => Effect.sync(() => events.slice(mark)),
    readPage: (mark, limit) => Effect.sync(() =>
      events.slice(mark, mark + limit).map((event, index) => ({ seq: mark + index + 1, event }))
    ),
    writes
  }
}

describe("forkUntilOf", () => {
  test("digit strings become sequences and other strings stay ids", () => {
    expect(forkUntilOf(3)).toBe(3)
    expect(forkUntilOf("3")).toBe(3)
    expect(forkUntilOf("m1")).toBe("m1")
    expect(() => forkUntilOf(0)).toThrow("positive integer")
    expect(() => forkUntilOf("")).toThrow("nonempty")
  })
})

describe("prefixUntil", () => {
  test("a sequence copies through that row", () => {
    expect(prefixUntil(source, 1)).toEqual([created])
    expect(prefixUntil(source, 2)).toEqual([created, first])
    expect(prefixUntil(source, "2")).toEqual([created, first])
  })

  test("an event id copies through its first occurrence", () => {
    expect(prefixUntil(source, "m2")).toEqual(source)
    expect(eventIdentityOf(first)).toBe("m1")
  })

  test("a missing checkpoint is refused", () => {
    expect(() => prefixUntil(source, 4)).toThrow("past the log head 3")
    expect(() => prefixUntil(source, "ghost")).toThrow("not in the log")
  })
})

describe("copyPrefix", () => {
  test("copyPrefix is the store append function", async () => {
    const store = memoryStore()
    expect(store.copyPrefix).toBe(store.append)
    const result = await Effect.runPromise(copyPrefix(store, [first]))
    expect(result).toEqual({ appended: 1, head: 1 })
    expect(store.writes).toEqual([[first]])
    expect(await Effect.runPromise(store.read)).toEqual([first])
  })
})

describe("forkBatchOf", () => {
  test("the dest keeps its identity and records the source prefix", () => {
    const batch = forkBatchOf(source, { sourceThread: "root", until: 2, forkedAt: 40 })
    expect(batch).toEqual([
      first,
      { type: "ThreadForked", sourceThread: "root", until: 2, forkedAt: 40 }
    ])
    expect(matchingFork([...batch], "root", 2)).toBe(true)
    expect(matchingFork([...batch], "root", 3)).toBe(false)
  })

  test("ThreadForked refuses an empty source id", () => {
    expect(() => threadForked({ sourceThread: "", until: 1, forkedAt: 1 })).toThrow()
  })
})
