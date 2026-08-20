import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { BunHttpServer } from "@effect/platform-bun"
import type { Event } from "@clavia/tardigrade-core/event"
import { Infer, type InferRequest } from "@clavia/tardigrade"
import type { Action } from "@clavia/tardigrade/events"

import { openStreams, type EventRow } from "./api"
import { layerConfig, readConfig } from "./config"
import { layerAgents } from "./host"
import { PROBLEM_CONTENT_TYPE, serve } from "./http"
import type { AgentSummary, AgentNode, TurnView } from "./projections"

// The API over a real Bun server on an ephemeral port, over a real durable host on a volatile
// database, with the model seam bound to a scripted mind: every assertion here is about what a
// client sees on the wire, and the only thing that is not real is the model (host.ts, AgentsOptions).

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
  Layer.provide(layerAgents({ infer: layerScripted }), config)
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

const birth = async (base: string, id: string, message: { id: string; text: string }) => {
  const response = await post(base, `/agents/${id}/messages`, message)
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ agent: id, turn: message.id })
  return until(`turn ${message.id} of ${id}`, async () => {
    const view = (await (await fetch(`${base}/agents/${id}/turns/${message.id}`)).json()) as TurnView
    return view.status === "pending" ? undefined : view
  })
}

describe("messages", () => {
  test("a message births an agent and the server drives its turn to completed", async () => {
    const view = await serving((base) => birth(base, "alpha", { id: "m1", text: "hello" }))
    expect(view).toEqual({ turn: "m1", status: "completed", output: "ok: hello" })
  })

  test("a body with no id or no text is refused", async () => {
    const problems = await serving(async (base) => {
      const missingText = await post(base, "/agents/alpha/messages", { id: "m1" })
      const missingId = await post(base, "/agents/alpha/messages", { text: "hello" })
      return [
        { status: missingText.status, type: missingText.headers.get("content-type"), body: await missingText.json() },
        { status: missingId.status, type: missingId.headers.get("content-type"), body: await missingId.json() }
      ]
    })
    for (const refused of problems) {
      expect(refused.status).toBe(400)
      expect(refused.type).toContain(PROBLEM_CONTENT_TYPE)
      expect(refused.body).toMatchObject({ status: 400, title: "Invalid Message" })
    }
  })

  test("a redelivered message id answers the same and writes nothing", async () => {
    const counts = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const before = ((await (await fetch(`${base}/agents/alpha/events`)).json()) as ReadonlyArray<EventRow>).length
      const again = await post(base, "/agents/alpha/messages", { id: "m1", text: "hello" })
      expect(again.status).toBe(202)
      expect(await again.json()).toEqual({ agent: "alpha", turn: "m1" })
      await sleep(50)
      const after = ((await (await fetch(`${base}/agents/alpha/events`)).json()) as ReadonlyArray<EventRow>).length
      return [before, after]
    })
    expect(counts[1]).toBe(counts[0]!)
  })
})

describe("the listing", () => {
  test("an agent that has settled lists as settled", async () => {
    const listed = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      return (await (await fetch(`${base}/agents`)).json()) as ReadonlyArray<AgentSummary>
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
      const all = await json("/agents/alpha/events")
      return {
        all,
        page: await json("/agents/alpha/events?after=1&limit=2"),
        completed: await json("/agents/alpha/events?types=TurnCompleted"),
        both: await json(`/agents/alpha/events?after=1&types=MessageReceived,TurnCompleted`),
        empty: await json("/agents/alpha/events?types=NothingLikeThis")
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
    // An existing agent's filtered empty page is a page, not a 404.
    expect(read.empty).toEqual([])
  })

  test("a log that never existed is the only 404", async () => {
    const answers = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const missing = await fetch(`${base}/agents/ghost/events`)
      return { status: missing.status, type: missing.headers.get("content-type"), body: await missing.json() }
    })
    expect(answers.status).toBe(404)
    expect(answers.type).toContain(PROBLEM_CONTENT_TYPE)
    expect(answers.body).toMatchObject({ status: 404, title: "Unknown Agent" })
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
      const before = (await (await fetch(`${base}/agents/alpha/events`)).json()) as ReadonlyArray<EventRow>
      const abort = new AbortController()
      const response = await fetch(`${base}/agents/alpha/events/stream?after=0`, {
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
      await post(base, "/agents/alpha/messages", { id: "m2", text: "again" })
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

describe("turns", () => {
  test("`at` reads the log's prefix, which takes a completed turn back to pending", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const json = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as ReadonlyArray<TurnView>
      return { now: await json("/agents/alpha/turns"), atOne: await json("/agents/alpha/turns?at=1") }
    })
    expect(read.now).toEqual([{ turn: "m1", status: "completed", output: "ok: hello" }])
    // One event stands before the cut: the message that asked for the turn, and nothing that
    // answered it.
    expect(read.atOne).toEqual([{ turn: "m1", status: "pending" }])
  })

  test("a turn nobody was asked to serve is a 404", async () => {
    const answer = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const missing = await fetch(`${base}/agents/alpha/turns/m9`)
      return { status: missing.status, body: await missing.json() }
    })
    expect(answer.status).toBe(404)
    expect(answer.body).toMatchObject({ status: 404, title: "Unknown Turn" })
  })

  test("a turn that did not fail refuses to resume", async () => {
    const answer = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const refused = await post(base, "/agents/alpha/turns/m1/resume")
      return { status: refused.status, type: refused.headers.get("content-type"), body: await refused.json() }
    })
    expect(answer.status).toBe(409)
    expect(answer.type).toContain(PROBLEM_CONTENT_TYPE)
    expect(answer.body).toMatchObject({ status: 409, title: "Resume Refused" })
    expect(String((answer.body as { detail?: unknown }).detail)).toContain("cannot resume")
  })
})

describe("the tree", () => {
  test("a spawned child hangs under the agent whose code briefed it", async () => {
    const read = await serving(async (base) => {
      await birth(base, "root", { id: "m1", text: "spawn call-1" })
      // The root's turn can complete while the child's lane is still settling, so the tree read
      // waits for the driver to rest; resting means every lane's owed work is done.
      await until("the driver rests", async () => {
        const health = (await (await fetch(`${base}/healthz`)).json()) as { status: string }
        return health.status === "resting" ? health : undefined
      })
      return {
        tree: (await (await fetch(`${base}/agents/root/tree`)).json()) as AgentNode,
        listed: (await (await fetch(`${base}/agents`)).json()) as ReadonlyArray<AgentSummary>,
        ghost: (await fetch(`${base}/agents/ghost/tree`)).status
      }
    })
    expect(read.tree.id).toBe("root")
    expect(read.tree.children).toHaveLength(1)
    const child = read.tree.children[0]!
    expect(child.parent).toBe("root")
    expect(child.children).toEqual([])
    // The child is an agent like any other: it lists, with the same parent the tree gave it.
    expect(read.listed.map((summary) => summary.id).sort()).toEqual(["root", child.id].sort())
    expect(read.listed.find((summary) => summary.id === child.id)!.parent).toBe("root")
    expect(read.ghost).toBe(404)
  })
})
