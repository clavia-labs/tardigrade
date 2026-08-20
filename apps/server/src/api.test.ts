import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { BunHttpServer } from "@effect/platform-bun"
import type { Event } from "@clavia/tardigrade-core/event"
import { Infer, type InferRequest } from "@clavia/tardigrade"
import type { Action } from "@clavia/tardigrade/events"

import { openStreams } from "./api"
import { layerConfig, readConfig } from "./config"
import { PROBLEM_TYPE_BASE, RESERVED_ACTOR, type EventRow } from "@clavia/tardigrade-client/contract"
import { layerThreads } from "./host"
import { PROBLEM_CONTENT_TYPE, serve } from "./http"
import type { TurnViewShape as TurnView } from "./actor"
import type { ThreadSummary, ThreadNode } from "./projections"

// Every case here boots a real server on an ephemeral port, so it competes with every other task in
// a parallel gate run. Bun's default per-test budget is tuned for a pure function and times out
// under that load; this is the budget a boot actually needs. It stays tight on purpose: a case that
// wants longer than this is hanging rather than busy.
const BOOT_MS = 20_000

setDefaultTimeout(BOOT_MS)

// The API over a real Bun server on an ephemeral port, over a real durable host on a volatile
// database, with the model seam bound to a scripted mind: every assertion here is about what a
// client sees on the wire, and the only thing that is not real is the model (host.ts, ThreadsOptions).

const briefOf = (trajectory: ReadonlyArray<Event>): string => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const event = trajectory[i]!
    if (event.type === "MessageReceived") return String((event as { text?: unknown }).text ?? "")
  }
  return ""
}

// The scripted mind answers in one attempt, except on a brief that asks it to spawn: there it runs
// one execution that briefs a child and answers with the child's answer, which is the shape the
// library's own spawn test drives (packages/agent/src/index.test.ts, the scripted mind). The tool
// call id is derived from the brief, so the child's id is stated by the test rather than by a
// counter (packages/agent/src/spawn.ts, `sibling`).
const scripted = ({ trajectory }: InferRequest): Action => {
  const brief = briefOf(trajectory)
  if (!brief.startsWith("spawn ")) return { kind: "complete", output: `ok: ${brief}` }
  const start = trajectory.reduce((n, event, i) => (event.type === "MessageReceived" ? i : n), 0)
  const returned = trajectory.slice(start).find((event) => event.type === "ToolReturned") as
    | { result?: { result?: unknown } }
    | undefined
  if (returned !== undefined) return { kind: "complete", output: JSON.stringify(returned.result?.result ?? null) }
  return {
    kind: "call",
    callId: brief.slice("spawn ".length),
    name: "execute",
    arguments: { code: `const a = await agents.run({ text: "hello child" }); return a.output;` }
  }
}

const layerScripted: Layer.Layer<Infer> = Layer.succeed(Infer)({
  react: (request: InferRequest) => Effect.succeed(scripted(request))
})

const config = layerConfig(readConfig({ TARDIGRADE_DB: ":memory:" }))

const app = Layer.provideMerge(serve({ disableLogger: true, disableListenLog: true }), [
  BunHttpServer.layer({ port: 0 }),
  config,
  Layer.provide(layerThreads({ infer: layerScripted }), config)
])

// Boots the process and hands the body its base URL. The body is plain fetch, because a client of
// this API is plain fetch.
const serving = <A>(body: (base: string) => Promise<A>): Promise<A> =>
  Effect.gen(function*() {
    const server = yield* HttpServer.HttpServer
    const address = server.address
    const port = address._tag === "TcpAddress" ? address.port : 0
    return yield* Effect.promise(() => body(`http://127.0.0.1:${port}`))
  }).pipe(Effect.provide(app), Effect.scoped, Effect.runPromise) as Promise<A>

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// until polls a question the server answers asynchronously, which is how a client waits for an
// outcome: the server drives continuously and never takes a wait (apps-server-spec.md,
// "Principles").
const until = async <A>(what: string, poll: () => Promise<A | undefined>, ms = 10_000): Promise<A> => {
  const deadline = Date.now() + ms
  for (;;) {
    const answer = await poll()
    if (answer !== undefined) return answer
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

const post = (base: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

// turnOf reads one turn through the actor's declared projection, narrowed by its `turn` query.
// There is no route that reads a turn by id: the single lookup is this query (actor.ts,
// agentProjections).
const turnOf = async (base: string, thread: string, turn: string): Promise<TurnView | undefined> => {
  const views = (await (await fetch(
    `${base}/v1/actors/agent/threads/${thread}/turns?turn=${encodeURIComponent(turn)}`
  )).json()) as ReadonlyArray<TurnView>
  return views[0]
}

const birth = async (base: string, id: string, message: { id: string; text: string }) => {
  const response = await post(base, `/v1/actors/agent/threads/${id}/events`, {
    type: "MessageReceived",
    ...message
  })
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ actor: RESERVED_ACTOR, thread: id })
  return until(`turn ${message.id} of ${id}`, async () => {
    const view = await turnOf(base, id, message.id)
    return view === undefined || view.status === "pending" ? undefined : view
  })
}

describe("appending", () => {
  test("an appended message births a thread and the server drives its turn to completed", async () => {
    const view = await serving((base) => birth(base, "alpha", { id: "m1", text: "hello" }))
    expect(view).toEqual({ turn: "m1", status: "completed", epoch: 0, output: "ok: hello" })
  })

  // `type` is the only field the platform requires, because an event is one fact and what its
  // other fields mean is the actor's knowledge (contract.ts, Append).
  test("a body with no type is refused", async () => {
    const problems = await serving(async (base) => {
      const noType = await post(base, "/v1/actors/agent/threads/alpha/events", { id: "m1", text: "hello" })
      const emptyType = await post(base, "/v1/actors/agent/threads/alpha/events", { type: "" })
      return [
        { status: noType.status, type: noType.headers.get("content-type"), body: await noType.json() },
        { status: emptyType.status, type: emptyType.headers.get("content-type"), body: await emptyType.json() }
      ]
    })
    for (const refused of problems) {
      expect(refused.status).toBe(400)
      expect(refused.type).toContain(PROBLEM_CONTENT_TYPE)
      expect(refused.body).toMatchObject({ status: 400, title: "Invalid Request" })
    }
    expect((problems[0]!.body as { detail: string }).detail).toContain("`type` is missing")
    expect((problems[1]!.body as { detail: string }).detail).toContain("`type` is not a value it accepts")
  })

  // Duplicate suppression is the actor's, keyed by its own `keyOf` (packages/core/src/message.ts,
  // messageKeys), so the platform appends and the assembly decides what a repeat means.
  test("a redelivered message id answers the same and writes nothing", async () => {
    const counts = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const before = ((await (await fetch(`${base}/v1/actors/agent/threads/alpha/events`)).json()) as ReadonlyArray<EventRow>).length
      const again = await post(base, "/v1/actors/agent/threads/alpha/events", {
        type: "MessageReceived",
        id: "m1",
        text: "hello"
      })
      expect(again.status).toBe(202)
      expect(await again.json()).toEqual({ actor: RESERVED_ACTOR, thread: "alpha" })
      await sleep(50)
      const after = ((await (await fetch(`${base}/v1/actors/agent/threads/alpha/events`)).json()) as ReadonlyArray<EventRow>).length
      return [before, after]
    })
    expect(counts[1]).toBe(counts[0]!)
  })
})

describe("the listing", () => {
  test("a thread that has settled lists as settled", async () => {
    const listed = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      return (await (await fetch(`${base}/v1/actors/agent/threads`)).json()) as ReadonlyArray<ThreadSummary>
    })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: "alpha", status: "settled" })
    expect(listed[0]!.events).toBeGreaterThan(0)
    expect(listed[0]!.parent).toBeUndefined()
  })
})

describe("events", () => {
  test("after and limit page the log, and types filters without renumbering it", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const json = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as ReadonlyArray<EventRow>
      const all = await json("/v1/actors/agent/threads/alpha/events")
      return {
        all,
        page: await json("/v1/actors/agent/threads/alpha/events?after=1&limit=2"),
        completed: await json("/v1/actors/agent/threads/alpha/events?types=TurnCompleted"),
        both: await json(`/v1/actors/agent/threads/alpha/events?after=1&types=MessageReceived,TurnCompleted`),
        empty: await json("/v1/actors/agent/threads/alpha/events?types=NothingLikeThis")
      }
    })
    expect(read.all.map((row) => row.seq)).toEqual(read.all.map((_, i) => i + 1))
    expect(read.page.map((row) => row.seq)).toEqual([2, 3])
    expect(read.page.map((row) => row.event)).toEqual(read.all.slice(1, 3).map((row) => row.event))
    // The filtered row keeps the seq it has in the whole log, so `after` means the same place with
    // a filter as without one.
    expect(read.completed).toHaveLength(1)
    const completed = read.all.find((row) => row.event.type === "TurnCompleted")!
    expect(read.completed[0]!.seq).toBe(completed.seq)
    expect(read.both.every((row) => row.seq > 1)).toBe(true)
    // An existing thread's filtered empty page is a page, not a 404.
    expect(read.empty).toEqual([])
  })

  test("a log that never existed is the only 404", async () => {
    const answers = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const missing = await fetch(`${base}/v1/actors/agent/threads/ghost/events`)
      return { status: missing.status, type: missing.headers.get("content-type"), body: await missing.json() }
    })
    expect(answers.status).toBe(404)
    expect(answers.type).toContain(PROBLEM_CONTENT_TYPE)
    expect(answers.body).toMatchObject({ status: 404, title: "Unknown Thread" })
  })
})

describe("the actor level", () => {
  // The actor is a path parameter so the declaration states the shape a deploy will vary, and this
  // build answers for one name (contract.ts, RESERVED_ACTOR). A name it does not serve is code
  // nobody deployed here, which is a different fact from a log nobody has written, so it carries a
  // different problem type even though both are 404 (api.ts, actorOf).
  test("an actor nobody deployed is its own 404", async () => {
    const answers = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const read = async (path: string) => {
        const response = await fetch(`${base}${path}`)
        return { status: response.status, body: await response.json() as Record<string, unknown> }
      }
      return {
        served: await read(`/v1/actors/${RESERVED_ACTOR}/threads`),
        ghost: await read("/v1/actors/ghost/threads"),
        ghostThread: await read("/v1/actors/ghost/threads/alpha/events")
      }
    })
    expect(answers.served.status).toBe(200)
    expect(answers.ghost.status).toBe(404)
    expect(answers.ghost.body).toMatchObject({ title: "Unknown Actor" })
    // The actor is answered before the thread, so a real thread under a name nobody deployed still
    // reports the actor rather than the log.
    expect(answers.ghostThread.status).toBe(404)
    expect(answers.ghostThread.body).toMatchObject({ title: "Unknown Actor" })
  })

  // The tail decodes its own request because it is not a declared endpoint (contract.ts, the SSE
  // note), so it carries its own copy of the same guard.
  test("the tail refuses an actor nobody deployed", async () => {
    const answers = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const response = await fetch(`${base}/v1/actors/ghost/threads/alpha/events/stream`)
      return { status: response.status, type: response.headers.get("content-type"), body: await response.json() }
    })
    expect(answers.status).toBe(404)
    expect(answers.type).toContain(PROBLEM_CONTENT_TYPE)
    expect(answers.body).toMatchObject({ title: "Unknown Actor" })
  })
})

// framesOf parses an SSE byte stream into the pairs a client acts on. It is deliberately literal:
// the assertions below are about the wire format, so nothing here normalizes it.
const framesOf = (text: string): ReadonlyArray<{ readonly id: string; readonly data: string }> =>
  text
    .split("\n\n")
    .filter((frame) => frame.startsWith("id:"))
    .map((frame) => {
      const lines = frame.split("\n")
      return {
        id: lines.find((line) => line.startsWith("id:"))!.slice(3).trim(),
        data: lines.find((line) => line.startsWith("data:"))!.slice(5).trim()
      }
    })

describe("the event stream", () => {
  test("a reconnect replays from Last-Event-ID and then runs live, once each", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const before = (await (await fetch(`${base}/v1/actors/agent/threads/alpha/events`)).json()) as ReadonlyArray<EventRow>
      const abort = new AbortController()
      const response = await fetch(`${base}/v1/actors/agent/threads/alpha/events/stream?after=0`, {
        // The header wins over the query, which is the whole of what a resuming EventSource can
        // state: it replays the URL it was opened with and carries the id in the header.
        headers: { "last-event-id": "2" },
        signal: abort.signal
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let text = ""
      const pump = (async () => {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) return
          text += decoder.decode(chunk.value, { stream: true })
        }
      })().catch(() => undefined)

      // The backlog past the resumed id arrives first.
      await until("the replayed backlog", async () => (framesOf(text).length >= before.length - 2 ? true : undefined))
      const replayed = framesOf(text)
      expect(openStreams()).toBe(1)

      // Then a message delivered while the stream is open arrives on it.
      await post(base, "/v1/actors/agent/threads/alpha/events", { type: "MessageReceived", id: "m2", text: "again" })
      await until("the live frames", async () => (framesOf(text).length > replayed.length ? true : undefined))
      const live = framesOf(text)

      abort.abort()
      await pump
      const closed = await until("the tail to close", async () => (openStreams() === 0 ? true : undefined), 5_000)
      return { before, replayed, live, closed }
    })

    // Replay starts past the id the client held and repeats nothing.
    expect(read.replayed[0]!.id).toBe("3")
    expect(read.replayed.map((frame) => frame.id)).toEqual(read.before.slice(2).map((row) => String(row.seq)))
    expect(JSON.parse(read.replayed[0]!.data)).toEqual(read.before[2]!.event as never)
    // The live frames continue the same numbering, and every id appears exactly once.
    const ids = read.live.map((frame) => frame.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.map(Number)).toEqual(ids.map((_, i) => i + 3))
    expect(read.live.some((frame) => JSON.parse(frame.data).id === "m2")).toBe(true)
    // And the disconnect took the poll with it.
    expect(read.closed).toBe(true)
  })
})

// The projections the actor declares are mounted by name under a thread, and this build's actor
// declares `turns` (actor.ts, agentProjections). The cases below are about the mounting: that a
// declared name serves what the actor computes, that its own query reaches `run`, and that any
// other name says what does exist.
describe("projections", () => {
  test("a declared projection serves what the actor computes", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const response = await fetch(`${base}/v1/actors/agent/threads/alpha/turns`)
      return { status: response.status, body: await response.json() as ReadonlyArray<TurnView> }
    })
    expect(read.status).toBe(200)
    expect(read.body).toEqual([{ turn: "m1", status: "completed", epoch: 0, output: "ok: hello" }])
  })

  test("a name the actor never declared says what does exist", async () => {
    const answers = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const read = async (path: string) => {
        const response = await fetch(`${base}${path}`)
        return {
          status: response.status,
          type: response.headers.get("content-type"),
          body: await response.json() as Record<string, unknown>
        }
      }
      return { ghost: await read("/v1/actors/agent/threads/alpha/facts"), actor: await read("/v1/actors/ghost/threads/alpha/facts") }
    })
    expect(answers.ghost.status).toBe(404)
    expect(answers.ghost.type).toContain(PROBLEM_CONTENT_TYPE)
    expect(answers.ghost.body).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}unknown-projection`,
      title: "Unknown Projection"
    })
    // The detail lists what the actor does declare, so a caller who guessed a name learns the ones
    // that exist rather than only that this one does not.
    expect(String(answers.ghost.body["detail"])).toContain('"turns"')
    // The actor is answered before the projection: a name nobody deployed is not a place where
    // asking what it declares means anything.
    expect(answers.actor.body).toMatchObject({ title: "Unknown Actor" })
  })

  // `events` is the log read back, and the log is not a projection of itself, so a reserved name
  // keeps serving the platform's own route rather than reaching the projection mount. `stream` is
  // the same rule for the tail, proven where the tail is exercised ("the event stream", below;
  // contract.ts, RESERVED_PROJECTIONS).
  test("a reserved name still serves the log", async () => {
    const answers = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const events = await fetch(`${base}/v1/actors/agent/threads/alpha/events`)
      return { status: events.status, type: events.headers.get("content-type") }
    })
    expect(answers.status).toBe(200)
    // Not a problem document, which is what reaching the projection mount would have produced.
    expect(answers.type).toContain("application/json")
  })

  test("`at` reads the log's prefix, which takes a completed turn back to pending", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const json = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as ReadonlyArray<TurnView>
      return { now: await json("/v1/actors/agent/threads/alpha/turns"), atOne: await json("/v1/actors/agent/threads/alpha/turns?at=1") }
    })
    expect(read.now).toEqual([{ turn: "m1", status: "completed", epoch: 0, output: "ok: hello" }])
    // One event stands before the cut: the message that asked for the turn, and nothing that
    // answered it.
    expect(read.atOne).toEqual([{ turn: "m1", status: "pending", epoch: 0 }])
  })

  // The single lookup is the same projection with its `turn` query, which is why the platform keeps
  // no turn-shaped route at all (actor.ts, agentProjections).
  test("`turn` narrows the projection to one entry, and an unknown turn is an empty array", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const json = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as ReadonlyArray<TurnView>
      return {
        one: await json("/v1/actors/agent/threads/alpha/turns?turn=m1"),
        ghost: await json("/v1/actors/agent/threads/alpha/turns?turn=m9")
      }
    })
    expect(read.one).toEqual([{ turn: "m1", status: "completed", epoch: 0, output: "ok: hello" }])
    // A turn nobody was asked to serve matches nothing. It is not a failure: asking a projection
    // about an id it has never seen is a question with an empty answer.
    expect(read.ghost).toEqual([])
  })
})

describe("the tree", () => {
  test("a spawned child hangs under the thread whose code briefed it", async () => {
    const read = await serving(async (base) => {
      await birth(base, "root", { id: "m1", text: "spawn call-1" })
      // The root's turn can complete while the child's lane is still settling, so the tree read
      // waits for the driver to rest; resting means every lane's owed work is done.
      await until("the driver rests", async () => {
        const health = (await (await fetch(`${base}/healthz`)).json()) as { status: string }
        return health.status === "resting" ? health : undefined
      })
      return {
        tree: (await (await fetch(`${base}/v1/actors/agent/threads/root/tree`)).json()) as ThreadNode,
        listed: (await (await fetch(`${base}/v1/actors/agent/threads`)).json()) as ReadonlyArray<ThreadSummary>,
        ghost: (await fetch(`${base}/v1/actors/agent/threads/ghost/tree`)).status
      }
    })
    expect(read.tree.id).toBe("root")
    expect(read.tree.children).toHaveLength(1)
    const child = read.tree.children[0]!
    expect(child.parent).toBe("root")
    expect(child.children).toEqual([])
    // The child is a thread like any other: it lists, with the same parent the tree gave it.
    expect(read.listed.map((summary) => summary.id).sort()).toEqual(["root", child.id].sort())
    expect(read.listed.find((summary) => summary.id === child.id)!.parent).toBe("root")
    expect(read.ghost).toBe(404)
  })
})
