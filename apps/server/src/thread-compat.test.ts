import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { ActorThreadRecord } from "@clavia/tardigrade-core/actor"
import type { ActorThreads } from "./host"
import { publicThreadId, resolveThreadId, withLegacyThreadIds } from "./thread-compat"

const lookup = (...ids: string[]): ActorThreads["actorThread"] => (thread) => Effect.succeed(
  ids.includes(thread) ? { thread, depth: 0, state: "registered" } : undefined
)
const exists = (...ids: string[]) => (thread: string) => Effect.succeed(ids.includes(thread))

test("legacy public names retain their stored addresses", async () => {
  expect(publicThreadId("ag.root")).toBe("root")
  expect(publicThreadId("ag.ag.root")).toBe("ag.root")
  expect(await Effect.runPromise(resolveThreadId("root", exists("ag.root")))).toBe("ag.root")
  expect(await Effect.runPromise(resolveThreadId("ag.root", exists("ag.ag.root")))).toBe("ag.ag.root")
})

test("new thread ids are stored as supplied", async () => {
  for (const id of ["root", "ag.root", "thread_abc", "one:two", "三"]) {
    expect(await Effect.runPromise(resolveThreadId(id, exists()))).toBe(id)
  }
})

test("registered opaque thread ids round-trip without a required prefix", async () => {
  for (const id of ["thread_abc", "worker", "one:two", "三"]) {
    expect(publicThreadId(id)).toBe(id)
    expect(await Effect.runPromise(resolveThreadId(id, exists(id)))).toBe(id)
  }
})

test("ambiguous public ids fail instead of selecting another log", async () => {
  await expect(Effect.runPromise(resolveThreadId("root", exists("root", "ag.root")))).rejects.toThrow("ambiguous")
})

test("the adapter translates public operations while preserving raw directory records", async () => {
  const records: ActorThreadRecord[] = [
    { thread: "ag.root", depth: 0, state: "registered" },
    { thread: "thread_child", parentThread: "ag.root", depth: 1, state: "registered" }
  ]
  const received: string[] = []
  const capture = (thread: string) => Effect.sync(() => { received.push(thread) })
  const raw: ActorThreads = {
    methods: {}, sqlite: ":memory:",
    append: (thread) => capture(thread),
    events: (thread) => capture(thread).pipe(Effect.as([])),
    eventsPage: (thread) => capture(thread).pipe(Effect.as([])),
    awaitHead: (thread) => capture(thread).pipe(Effect.as(0)),
    actorEventsPage: () => Effect.succeed([]),
    actorThreads: Effect.succeed({ cursor: 2, threads: records }),
    actorThread: lookup(...records.map((record) => record.thread)),
    awaitActorHead: () => Effect.succeed(2),
    list: Effect.succeed(records.map((record) => ({ id: record.thread, events: [] }))),
    settled: Effect.void
  }
  const api = withLegacyThreadIds(raw)
  await Effect.runPromise(api.append("root", { type: "MessageReceived" }))
  await Effect.runPromise(api.events("thread_child"))
  await Effect.runPromise(api.eventsPage("root", 0, 10))
  await Effect.runPromise(api.awaitHead("thread_child", 0))
  expect(received).toEqual(["ag.root", "thread_child", "ag.root", "thread_child"])
  expect((await Effect.runPromise(api.list)).map((entry) => entry.id)).toEqual(["root", "thread_child"])
  expect(await Effect.runPromise(api.actorThreads)).toEqual({ cursor: 2, threads: records })
  await expect(Effect.runPromise(withLegacyThreadIds({
    ...raw, list: Effect.succeed([{ id: "ag.root", events: [] }, { id: "root", events: [] }])
  }).list)).rejects.toThrow("ambiguous")
})
