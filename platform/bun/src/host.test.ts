import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Tracer } from "effect"
import type { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { actorFromReactors, effect, type Actor, type Reactor } from "@clavia/tardigrade-core/reconciliation"
import { methodTimeoutKeys, methodTimeoutReactor } from "@clavia/tardigrade-core/actor/method"
import { parseThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import { envelopeOf } from "@clavia/tardigrade-core/communication/envelope"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { threadCreated } from "@clavia/tardigrade-core/thread"
import { hydrate, refs, spill } from "@clavia/tardigrade-code/storage/store"
import { jsSandboxService, Sandbox } from "@clavia/tardigrade-code/sandbox/service"

import { workspaceFor, WORKSPACE_SQL_DESCRIPTION } from "@clavia/tardigrade-code/package/workspace"

import { bunThreadDatabasePath, createBunHost, type BunHost, type BunHostOptions } from "./host"
import type { BunAlarmHandle, BunAlarmScheduler } from "./alarm"
import { fileTelemetry } from "./file"
import {
  bunWorkspace,
  bunWorkspaceLogSqlDoc,
  bunWorkspaceSql,
  DEFAULT_BUN_WORKSPACE_SQL_DOC,
  WORKSPACE_TABLE
} from "./workspace"

// Every case here opens a real store on disk and drives a real host, so it competes with every
// other task in a parallel gate run. Bun's default per-test budget is tuned for a pure function and
// times out under that load; this is the budget a boot actually needs. It stays tight on purpose: a
// case that wants longer than this is hanging rather than busy.
const BOOT_MS = 20_000

setDefaultTimeout(BOOT_MS)

// The bun binding against the reference host's contract, plus the two behaviors only physics
// can show: a reopened database keeps the log, and recover() settles work a death interrupted.

const keyOf = (e: Event): string | undefined =>
  e.type === "Done" ? `dn:${String((e as { id?: unknown }).id)}` : undefined

// One reactor: every MessageReceived owes one keyed Done.
const echoReactor: Reactor = (events) =>
  events
    .filter((e) => e.type === "MessageReceived")
    .map((e) => {
      const id = String((e as { id?: unknown }).id)
      return effect({
        key: `dn:${id}`,
        input: id,
        act: (input: string) => Effect.succeed([{ type: "Done", id: input, at: 1 } as Event])
      })
    })

const echo: Actor = { reactors: [echoReactor], keyOf }

const dir = mkdtempSync(join(tmpdir(), "tardigrade-bun-"))
let n = 0
const freshPath = (): string => join(dir, `host-${n++}.sqlite`)

const created = (thread: string, at = 0): Event => threadCreated({ actor: "bun", instance: "default", thread }, undefined, at)

const signal = (): { readonly promise: Promise<void>; readonly send: () => void } => {
  let send!: () => void
  const promise = new Promise<void>((resolve) => {
    send = resolve
  })
  return { promise, send }
}

class ManualAlarmScheduler implements BunAlarmScheduler {
  readonly entries: Array<{
    readonly deadlineAt: number
    readonly fire: (at: number) => Promise<void>
    cancelled: boolean
  }> = []

  schedule(deadlineAt: number, fire: (at: number) => Promise<void>): BunAlarmHandle {
    const entry = { deadlineAt, fire, cancelled: false }
    this.entries.push(entry)
    return { cancel: () => { entry.cancelled = true } }
  }

  get pending(): ReadonlyArray<number> {
    return this.entries.filter((entry) => !entry.cancelled).map((entry) => entry.deadlineAt)
  }

  async advanceTo(at: number): Promise<void> {
    const due = this.entries.filter((entry) => !entry.cancelled && entry.deadlineAt <= at)
    for (const entry of due) {
      entry.cancelled = true
      await entry.fire(at)
    }
  }
}

const options = (path: string): BunHostOptions<never> => ({
  database: path,
  actorFor: (thread) => (thread === "echo" ? echo : undefined),
  keyOf
})

describe("the bun host", () => {
  test("runs actor code in its process sandbox", async () => {
    const actor: Actor = {
      keyOf,
      reactors: [(events) => events
        .filter((event) => event.type === "MessageReceived")
        .map((event) => {
          const id = String((event as { id?: unknown }).id)
          return effect({
            key: `dn:${id}`,
            input: id,
            act: (input: string) => Effect.gen(function* () {
              const sandbox = yield* Sandbox
              const outcome = yield* sandbox.run("return typeof process", {})
              return [{ type: "Done", id: input, value: outcome.result, at: 1 } as Event]
            })
          })
        })]
    }
    const h = await createBunHost({
      database: freshPath(),
      actorFor: () => actor,
      keyOf,
      layersFor: () => Layer.succeed(Sandbox, jsSandboxService)
    })

    await h.commitRoot("bun:default:isolated", { type: "MessageReceived", id: "isolated", at: 0 } as Event)
    await h.drive()

    expect(await h.read("isolated")).toContainEqual({
      type: "Done",
      id: "isolated",
      value: "undefined",
      at: 1
    })
    await h.close()
  })

  test("settles distinct threads up to the configured capacity", async () => {
    const release = signal()
    const twoStarted = signal()
    let active = 0
    let peak = 0
    let started = 0
    const actor: Actor = {
      keyOf,
      reactors: [(events) =>
        events
          .filter((event) => event.type === "MessageReceived")
          .map((event) => {
            const id = String((event as { id?: unknown }).id)
            return effect({
              key: `dn:${id}`,
              input: id,
              act: (input: string) => Effect.promise(async () => {
                active += 1
                peak = Math.max(peak, active)
                started += 1
                if (started === 2) twoStarted.send()
                await release.promise
                active -= 1
                return [{ type: "Done", id: input, at: 1 } as Event]
              })
            })
          })]
    }
    const h = await createBunHost({
      database: freshPath(),
      actorFor: () => actor,
      keyOf,
      driver: { maxConcurrentThreads: 2 }
    })
    for (const thread of ["a", "b", "c"]) {
      await h.commitRoot(`bun:default:${thread}`, { type: "MessageReceived", id: thread, at: 0 } as Event)
    }

    const driving = h.drive()
    await twoStarted.promise
    expect(active).toBe(2)
    expect(h.work()).toBe(3)
    expect(await h.resting()).toBe(false)
    release.send()
    await driving

    expect(peak).toBe(2)
    expect(h.work()).toBe(0)
    expect(await h.resting()).toBe(true)
    await h.close()
  })

  test("creates the directory for a nested log path", async () => {
    const path = join(dir, `nested-${n++}`, "agents.sqlite")
    const h = await createBunHost(options(path))
    expect(existsSync(path)).toBe(true)
    await h.close()
  })

  test("delivers, settles, and a keyed redelivery absorbs", async () => {
    const h = await createBunHost(options(freshPath()))
    await h.commitRoot("bun:default:echo", { type: "MessageReceived", id: "m1", text: "go", at: 1 } as Event)
    await h.drive()
    expect((await h.read("echo")).map((e) => e.type)).toEqual(["ThreadCreated", "MessageReceived", "Done"])
    // The same keyed event again: absorbed inside the append transaction, the log does not grow.
    await h.commitRoot("bun:default:echo", { type: "Done", id: "m1", at: 2 } as Event)
    await h.drive()
    expect(await h.read("echo")).toHaveLength(3)
    // The same message id again: receiver dedup.
    await h.commitRoot("bun:default:echo", { type: "MessageReceived", id: "m1", text: "go", at: 3 } as Event)
    expect(await h.read("echo")).toHaveLength(3)
    expect(await h.resting()).toBe(true)
    await h.close()
  })

  test("refuses an unkeyed cross-thread event, identically to the reference host", async () => {
    const h = await createBunHost(options(freshPath()))
    expect(h.commitRoot("bun:default:echo", { type: "Mystery", at: 1 } as Event)).rejects.toThrow("unkeyed cross-thread event")
    await h.close()
  })

  test("a reopened database keeps the log byte for byte", async () => {
    const path = freshPath()
    const first = await createBunHost(options(path))
    await first.commitRoot("bun:default:echo", { type: "MessageReceived", id: "m1", text: "go", at: 1 } as Event)
    await first.drive()
    const before = await first.read("echo")
    await first.close()

    const second = await createBunHost(options(path))
    expect(await second.read("echo")).toEqual(before)
    expect(await second.resting()).toBe(true)
    await second.close()
  })

  test("recover() settles work a death interrupted", async () => {
    const path = freshPath()
    const first = await createBunHost(options(path))
    // The message lands; the process dies before any drive. The owed Done exists only as a
    // derivation over the surviving log.
    await first.seed("echo", [created("echo"), { type: "MessageReceived", id: "m9", text: "go", at: 1 } as Event])
    expect(await first.resting()).toBe(false)
    await first.close()

    const second = await createBunHost(options(path))
    await second.recover()
    expect((await second.read("echo")).map((e) => e.type)).toEqual(["ThreadCreated", "MessageReceived", "Done"])
    expect(await second.resting()).toBe(true)
    await second.close()
  })

  test("recovery rearms a durable method deadline and records its observed alarm", async () => {
    const path = freshPath()
    const timeoutActor = actorFromReactors([methodTimeoutReactor], methodTimeoutKeys.keyOf)
    const firstAlarm = new ManualAlarmScheduler()
    const first = await createBunHost({
      database: path,
      actorFor: () => timeoutActor,
      keyOf: methodTimeoutKeys.keyOf,
      alarm: firstAlarm
    })
    await first.seed("caller", [
      created("caller"),
      {
        type: "CallDispatched",
        id: "inspect-1",
        method: "inspect",
        target: "inspector:shared",
        input: {},
        timeoutMs: 50,
        deadlineAt: 50,
        at: 0
      }
    ])
    await first.recover()
    expect(firstAlarm.pending).toEqual([50])
    await first.close()
    expect(firstAlarm.pending).toEqual([])

    const recoveredAlarm = new ManualAlarmScheduler()
    const recovered = await createBunHost({
      database: path,
      actorFor: () => timeoutActor,
      keyOf: methodTimeoutKeys.keyOf,
      alarm: recoveredAlarm
    })
    await recovered.recover()
    expect(recoveredAlarm.pending).toEqual([50])
    await recoveredAlarm.advanceTo(53)

    expect(await recovered.read("caller")).toContainEqual({
      type: "AlarmFired",
      scheduledFor: 50,
      at: 53
    })
    expect(await recovered.read("caller")).toContainEqual({
      type: "CallTimedOut",
      call: "inspect-1",
      method: "inspect",
      target: "inspector:shared",
      timeoutMs: 50,
      deadlineAt: 50,
      at: 53
    })
    expect(recoveredAlarm.pending).toEqual([])
    expect(await recovered.resting()).toBe(true)
    await recovered.close()
  })

  test("threads names every thread the log holds", async () => {
    const h = await createBunHost(options(freshPath()))
    expect(await h.threads()).toEqual([])
    await h.commitRoot("bun:default:echo", { type: "MessageReceived", id: "m1", text: "go", at: 1 } as Event)
    await h.seed("other", [created("other"), { type: "MessageReceived", id: "m2", text: "go", at: 2 } as Event])
    await h.drive()
    expect(await h.threads()).toEqual(["echo", "other"])
    await h.close()
  })

  test("each thread owns a separate database", async () => {
    const path = freshPath()
    const h = await createBunHost(options(path))
    await h.seed("first", [created("first")])
    await h.seed("second", [created("second")])
    expect(bunThreadDatabasePath(path, "first")).not.toBe(bunThreadDatabasePath(path, "second"))
    expect(existsSync(bunThreadDatabasePath(path, "first"))).toBe(true)
    expect(existsSync(bunThreadDatabasePath(path, "second"))).toBe(true)
    await h.close()

    const actor = new Database(path)
    const thread = new Database(bunThreadDatabasePath(path, "first"))
    expect(actor.query("SELECT migration_id, name FROM effect_sql_migrations").all()).toEqual([
      { migration_id: 1, name: "actor_identity" },
      { migration_id: 2, name: "actor_directory" }
    ])
    expect(thread.query("SELECT migration_id, name FROM effect_sql_migrations").all()).toEqual([
      { migration_id: 1, name: "thread_identity" },
      { migration_id: 2, name: "thread_events" }
    ])
    actor.close()
    thread.close()
  })

  test("a batch appends atomically: a mid-batch key collision absorbs that row only", async () => {
    const h = await createBunHost(options(freshPath()))
    await h.seed("echo", [created("echo"), { type: "Done", id: "a", at: 1 } as Event])
    await h.seed("echo", [
      { type: "Done", id: "b", at: 2 } as Event,
      { type: "Done", id: "a", at: 3 } as Event,
      { type: "Done", id: "c", at: 4 } as Event
    ])
    expect((await h.read("echo")).filter((e) => e.type === "Done").map((e) => String((e as { id?: unknown }).id))).toEqual(["a", "b", "c"])
    await h.close()
  })

  test("a child creation and its first delivery commit together", async () => {
    const h = await createBunHost(options(freshPath()))
    const parent = parseThreadAddress("bun:default:parent")
    const target = parseThreadAddress("bun:default:child")
    const first = envelopeOf(
      linkOf(parent, target),
      { type: "MessageReceived", id: "m1", text: "work", at: 7 } as Event,
      { parent, depth: 1 }
    )
    await h.commit(first)
    await h.commit(first)
    expect(await h.read("child")).toEqual([
      threadCreated(target, { parent, depth: 1 }, 7),
      expect.objectContaining({ type: "MessageReceived", id: "m1", link: first.link })
    ])
    await expect(h.commit(envelopeOf(
      linkOf(parseThreadAddress("bun:default:other"), target),
      { type: "MessageReceived", id: "m2", text: "work", at: 8 } as Event,
      { parent: parseThreadAddress("bun:default:other"), depth: 1 }
    ))).rejects.toThrow("already has different lineage")
    await h.close()
  })

  test("a refused initial actor delivery leaves no partial creation", async () => {
    const h = await createBunHost(options(freshPath()))
    await expect(h.commit(envelopeOf(
      linkOf(parseThreadAddress("bun:default:parent"), parseThreadAddress("bun:default:child")),
      { type: "MessageReceived", id: "m1", text: "work", at: 1 } as Event
    ))).rejects.toThrow("must carry lineage")
    expect(await h.read("child")).toEqual([])
    await h.close()
  })
})

// The workspace the host binds: a value spilled by one process is on disk, so the next process
// hydrates the same bytes and reads the same manifest.

const REF = "e1.result"
const VALUE = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i, text: "wideé\n\"quoted\"" })) })

const workspaceKeyOf = (e: Event): string | undefined =>
  e.type === "Spilled" || e.type === "Loaded" ? `${e.type}:${String((e as { id?: unknown }).id)}` : undefined

// One reactor spills, the other hydrates: the pair runs in two processes over one database file.
const reactorOver = (
  type: string,
  act: (id: string) => Effect.Effect<Event, KeyValueStore.KeyValueStoreError, KeyValueStore.KeyValueStore>
): Reactor<KeyValueStore.KeyValueStore> =>
(events) =>
  events
    .filter((e) => e.type === "MessageReceived")
    .map((e) => {
      const id = String((e as { id?: unknown }).id)
      return effect({
        key: `${type}:${id}`,
        input: id,
        act: (input: string) => act(input).pipe(Effect.map((event) => [event]), Effect.orDie)
      })
    })

const spiller: Actor<KeyValueStore.KeyValueStore> = {
  keyOf: workspaceKeyOf,
  reactors: [reactorOver("Spilled", (id) => Effect.as(spill(REF, VALUE), { type: "Spilled", id, at: 1 } as Event))]
}

const loader: Actor<KeyValueStore.KeyValueStore> = {
  keyOf: workspaceKeyOf,
  reactors: [
    reactorOver("Loaded", (id) =>
      Effect.map(Effect.all([hydrate(REF), refs()]), ([value, held]) => ({ type: "Loaded", id, value, refs: held, at: 1 } as Event)))
  ]
}

describe("the durable workspace", () => {
  test("a value spilled before a restart hydrates from disk, manifest and all", async () => {
    const path = freshPath()
    const first = await createBunHost({
      database: path,
      keyOf: workspaceKeyOf,
      actorFor: (thread) => (thread === "ws" ? spiller : undefined)
    })
    await first.seed("ws", [created("ws"), { type: "MessageReceived", id: "m1", text: "spill", at: 1 } as Event])
    await first.wake("ws")
    await first.close()

    const second = await createBunHost({
      database: path,
      keyOf: workspaceKeyOf,
      actorFor: (thread) => (thread === "ws" ? loader : undefined)
    })
    await second.seed("ws", [{ type: "MessageReceived", id: "m2", text: "load", at: 2 } as Event])
    await second.wake("ws")
    const loaded = (await second.read("ws")).find((e) => e.type === "Loaded") as { value?: unknown; refs?: unknown }
    expect(loaded.value).toBe(VALUE)
    expect(loaded.refs).toEqual([REF])
    await second.close()
  })

  test("the workspace option replaces the default store", async () => {
    const path = freshPath()
    const first = await createBunHost({
      database: path,
      keyOf: workspaceKeyOf,
      workspace: bunWorkspace("elsewhere"),
      actorFor: (thread) => (thread === "ws" ? spiller : undefined)
    })
    await first.seed("ws", [created("ws"), { type: "MessageReceived", id: "m1", text: "spill", at: 1 } as Event])
    await first.wake("ws")
    await first.close()

    // The default table never saw the write: a host on it hydrates nothing.
    const second = await createBunHost({
      database: path,
      keyOf: workspaceKeyOf,
      actorFor: (thread) => (thread === "ws" ? loader : undefined)
    })
    await second.seed("ws", [{ type: "MessageReceived", id: "m2", text: "load", at: 2 } as Event])
    await second.wake("ws")
    const loaded = (await second.read("ws")).find((e) => e.type === "Loaded") as { value?: unknown; refs?: unknown }
    expect(loaded.value).toBeUndefined()
    expect(loaded.refs).toEqual([])
    await second.close()
  })
})

describe("telemetry seam", () => {
  test("spans flow to a supplied tracer: commit and the transition fire, keyed", async () => {
    const names: Array<{ name: string; key?: unknown; type?: unknown }> = []
    const linked: Array<{ name: string; traceId: string }> = []
    const capture = Layer.succeed(Tracer.Tracer)(
      Tracer.make({
        span(options) {
          for (const l of options.links) linked.push({ name: options.name, traceId: l.span.traceId })
          const record = (k: string, v: unknown) =>
            names.push({ name: options.name, ...(k === "key" ? { key: v } : {}), ...(k === "type" ? { type: v } : {}) })
          return {
            _tag: "Span",
            spanId: "s",
            traceId: "t",
            name: options.name,
            parent: options.parent,
            annotations: options.annotations,
            links: options.links,
            kind: options.kind,
            sampled: true,
            status: { _tag: "Started", startTime: options.startTime },
            attributes: new Map(),
            attribute: record,
            end() {},
            event() {},
            addLinks() {}
          } as never
        }
      })
    )
    const h = await createBunHost({ ...options(freshPath()), telemetry: capture })
    await h.commitRoot("bun:default:echo", { type: "MessageReceived", id: "m1", text: "go", at: 1 } as Event)
    await h.drive()
    expect(names.some((s) => s.name === "commit" && s.type === "MessageReceived")).toBe(true)
    expect(names.some((s) => s.name === "transition.fire" && s.key === "dn:m1")).toBe(true)
    // The cross-thread seam: the committed event carries the commit span's context, and the
    // fire links back to it: one business event, one trace.
    const row = (await h.read("echo")).find((event) => event.type === "MessageReceived") as { traceparent?: string }
    expect(row.traceparent).toMatch(/^00-t-s-01$/)
    expect(linked.some((l) => l.name === "transition.fire" && l.traceId === "t")).toBe(true)
    await h.close()
  })

  test("fileTelemetry lands queryable rows: the fire carries its outcome and links to the commit", async () => {
    const path = join(dir, `spans-${n++}.ndjson`)
    const h = await createBunHost({ ...options(freshPath()), telemetry: fileTelemetry(path) })
    await h.commitRoot("bun:default:echo", { type: "MessageReceived", id: "m1", text: "go", at: 1 } as Event)
    await h.drive()
    await h.close()
    const rows = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { SpanName: string; TraceId: string; Duration: number; StatusCode: string; SpanAttributes: Record<string, string>; Links: Array<{ TraceId: string }> })
    const committed = rows.find((r) => r.SpanName === "commit")
    const fired = rows.find((r) => r.SpanName === "transition.fire")
    expect(committed?.SpanAttributes["type"]).toBe("MessageReceived")
    expect(fired?.SpanAttributes["outcome"]).toBe("committed")
    expect(fired?.StatusCode).toBe("Ok")
    expect(fired?.Duration).toBeGreaterThan(0)
    expect(fired?.Links[0]?.TraceId).toBe(committed?.TraceId)
  })
})

// The SQL surface behind workspace.sql: the model's own database, bound by the host and reached
// through the workspace package exactly as an agent's thread reaches it.

const askKeyOf = (e: Event): string | undefined =>
  e.type === "Answered" ? `Answered:${String((e as { id?: unknown }).id)}` : undefined

type Answer = { rows?: ReadonlyArray<Record<string, unknown>>; truncated?: boolean; error?: string }

// One reactor runs the given statements through the thread's workspace package and records what came
// back, so a test reads the answers a model would read.
const asker = (queries: ReadonlyArray<string>): Actor<KeyValueStore.KeyValueStore> => ({
  keyOf: askKeyOf,
  reactors: [
    (events) =>
      events
        .filter((e) => e.type === "MessageReceived")
        .map((e) => {
          const id = String((e as { id?: unknown }).id)
          return effect({
            key: `Answered:${id}`,
            input: id,
            act: (input: string) =>
              Effect.gen(function* () {
                const pkg = yield* workspaceFor()
                const answers: Array<unknown> = []
                for (const query of queries) {
                  const method = pkg.methods["sql"]
                  if (method === undefined) break
                  answers.push(yield* method({ query, params: [] }, { callId: input }))
                }
                return [
                  {
                    type: "Answered",
                    id: input,
                    methods: Object.keys(pkg.methods).sort(),
                    doc: pkg.docs?.["sql"] !== undefined,
                    sqlDoc: pkg.docs?.["sql"]?.description ?? "",
                    answers,
                    at: 1
                  } as Event
                ]
              }).pipe(Effect.orDie)
          })
        })
  ]
})

const asked = async (
  host: BunHost,
  id: string
): Promise<{ methods: ReadonlyArray<string>; doc: boolean; sqlDoc: string; answers: ReadonlyArray<Answer> }> => {
  const creation = (await host.read("ws")).length === 0 ? [created("ws")] : []
  await host.seed("ws", [...creation, { type: "MessageReceived", id, text: "ask", at: 1 } as Event])
  await host.wake("ws")
  const found = (await host.read("ws")).find((e) => e.type === "Answered" && String((e as { id?: unknown }).id) === id)
  return found as unknown as {
    methods: ReadonlyArray<string>
    doc: boolean
    sqlDoc: string
    answers: ReadonlyArray<Answer>
  }
}

describe("the workspace sql surface", () => {
  test("the sql verb is bound, and the tables it creates outlive the process", async () => {
    const path = freshPath()
    const first = await createBunHost({
      database: path,
      keyOf: askKeyOf,
      actorFor: (thread) =>
        thread === "ws" ? asker(["CREATE TABLE notes (n TEXT)", "INSERT INTO notes VALUES ('kept')"]) : undefined
    })
    const wrote = await asked(first, "m1")
    expect(wrote.methods).toEqual(["grep", "read", "sql"])
    expect(wrote.doc).toBe(true)
    await first.close()

    const second = await createBunHost({
      database: path,
      keyOf: askKeyOf,
      actorFor: (thread) => (thread === "ws" ? asker(["SELECT n FROM notes"]) : undefined)
    })
    expect((await asked(second, "m2")).answers[0]?.rows).toEqual([{ n: "kept" }])
    await second.close()
  })

  test("the default surface does not reach the log", async () => {
    const h = await createBunHost({
      database: freshPath(),
      keyOf: askKeyOf,
      actorFor: (thread) => (thread === "ws" ? asker(["SELECT COUNT(*) AS n FROM events"]) : undefined)
    })
    expect((await asked(h, "m1")).answers[0]?.error).toContain("events")
    await h.close()
  })

  test("the sql doc says what the bound surface is, generic text first", async () => {
    const h = await createBunHost({
      database: freshPath(),
      keyOf: askKeyOf,
      actorFor: (thread) => (thread === "ws" ? asker([]) : undefined)
    })
    expect((await asked(h, "m1")).sqlDoc).toBe(`${WORKSPACE_SQL_DESCRIPTION} ${DEFAULT_BUN_WORKSPACE_SQL_DOC}`)
    await h.close()
  })

  test("a surface over the log's own client names the table the spilled values are in", async () => {
    const h = await createBunHost({
      database: freshPath(),
      keyOf: askKeyOf,
      workspaceSql: bunWorkspaceSql({ doc: bunWorkspaceLogSqlDoc() }),
      actorFor: (thread) => (thread === "ws" ? asker([]) : undefined)
    })
    expect((await asked(h, "m1")).sqlDoc).toBe(`${WORKSPACE_SQL_DESCRIPTION} ${bunWorkspaceLogSqlDoc()}`)
    expect(bunWorkspaceLogSqlDoc()).toContain(`${WORKSPACE_TABLE}(id, value, value_type)`)
    await h.close()
  })

  test("a broken query answers an error the model can read", async () => {
    const h = await createBunHost({
      database: freshPath(),
      keyOf: askKeyOf,
      actorFor: (thread) => (thread === "ws" ? asker(["SELECT * FROM nowhere"]) : undefined)
    })
    const answer = (await asked(h, "m1")).answers[0]
    expect(answer?.error).toContain("nowhere")
    expect(answer?.rows).toBeUndefined()
    await h.close()
  })

  test("an answer stops at the row cap and says truncated", async () => {
    const h = await createBunHost({
      database: freshPath(),
      keyOf: askKeyOf,
      workspaceSql: bunWorkspaceSql({ rows: 2 }),
      actorFor: (thread) =>
        thread === "ws"
          ? asker([
              "CREATE TABLE wide (n INTEGER)",
              "INSERT INTO wide VALUES (1), (2), (3), (4), (5)",
              "SELECT n FROM wide ORDER BY n"
            ])
          : undefined
    })
    const answer = (await asked(h, "m1")).answers[2]
    expect(answer?.rows).toEqual([{ n: 1 }, { n: 2 }])
    expect(answer?.truncated).toBe(true)
    await h.close()
  })

  test("the byte bound cuts a row set the row bound would pass", async () => {
    const h = await createBunHost({
      database: freshPath(),
      keyOf: askKeyOf,
      workspaceSql: bunWorkspaceSql({ bytes: 40 }),
      actorFor: (thread) =>
        thread === "ws"
          ? asker([
              "CREATE TABLE wide (n TEXT)",
              `INSERT INTO wide VALUES ('${"x".repeat(60)}'), ('short')`,
              "SELECT n FROM wide"
            ])
          : undefined
    })
    const answer = (await asked(h, "m1")).answers[2]
    expect(answer?.rows).toEqual([])
    expect(answer?.truncated).toBe(true)
    await h.close()
  })

  test("sql withheld: the package offers two verbs and no third", async () => {
    const h = await createBunHost({
      database: freshPath(),
      keyOf: askKeyOf,
      workspaceSql: false,
      actorFor: (thread) => (thread === "ws" ? asker(["SELECT 1"]) : undefined)
    })
    const answered = await asked(h, "m1")
    expect(answered.methods).toEqual(["grep", "read"])
    expect(answered.doc).toBe(false)
    expect(answered.answers).toEqual([])
    await h.close()
  })
})
