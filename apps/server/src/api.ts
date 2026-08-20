import { Duration, Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type { Event } from "@clavia/tardigrade-core/event"

import { Agents, type Inbound } from "./host"
import { problem } from "./problem"
import { treeOf, turnsOf, type AgentNode, type AgentSummary } from "./projections"

// The agent endpoints. A route is a lookup on the Agents service plus one projection, because the
// read side is a pure function of a log (projections.ts) and the write side is one delivery
// (host.ts). Nothing here holds state between requests: the SSE tail keeps a cursor for the
// connection it serves and nothing else, so two processes reading the same log answer the same way.

// The page size of GET /agents/:id/events when the caller states no `limit`
// (apps-server-spec.md, "GET /agents/:id/events").
export const DEFAULT_EVENT_LIMIT = 200

// How often an SSE tail re-reads the log looking for growth. The host has no change feed, so the
// tail polls; the interval is the delay a client sees between an event landing and the frame.
export const DEFAULT_SSE_POLL = Duration.millis(50)

// How long an idle tail waits before writing a comment frame. A proxy between the client and this
// process closes a connection that says nothing, and a comment is the cheapest thing to say.
export const DEFAULT_SSE_HEARTBEAT = Duration.seconds(15)

export interface ApiOptions {
  readonly limit?: number
  readonly poll?: Duration.Input
  readonly heartbeat?: Duration.Input
}

// EventRow is one row of GET /agents/:id/events. `seq` is the event's 1-based position in the whole
// log, assigned before any filter runs, so a `types` filter narrows the rows without renumbering
// them and `after` still means the same place (api.test.ts, "after and limit page the log, and
// types filters without renumbering it").
export interface EventRow {
  readonly seq: number
  readonly event: Event
}

const paramOf = (params: Readonly<Record<string, string | undefined>>, name: string): string =>
  params[name] ?? ""

const singleOf = (value: string | ReadonlyArray<string> | undefined): string | undefined =>
  value === undefined ? undefined : typeof value === "string" ? value : value[0]

// A query number is an integer at or above zero. Anything else is undefined here and a 400 at the
// call site: a caller who wrote `after=soon` asked for something, and answering page one instead
// hides the mistake behind plausible data.
const integerOf = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

const invalidQuery = (name: string, raw: string) =>
  problem({
    status: 400,
    kind: "invalid-query",
    title: "Invalid Query",
    detail: `\`${name}\` must be an integer at or above zero, got ${JSON.stringify(raw)}.`
  })

// An agent exists once its log has an event (apps-server-spec.md, "Principles"), so an empty log is
// the only unknown agent there is.
const unknownAgent = (id: string) =>
  problem({
    status: 404,
    kind: "unknown-agent",
    title: "Unknown Agent",
    detail: `No agent named ${JSON.stringify(id)} has ever existed.`
  })

// inboundOf reads the delivery body. `id` and `text` are the message, and a body missing either is
// refused rather than defaulted: the id is the dedup key end to end, so inventing one would turn a
// retry into a second turn (apps-server-spec.md, "Principles").
const inboundOf = (body: unknown): Inbound | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const { data, id, input, text } = body as Record<string, unknown>
  if (typeof id !== "string" || id.length === 0) return undefined
  if (typeof text !== "string") return undefined
  return {
    id,
    text,
    ...(input === undefined ? {} : { input }),
    ...(data === undefined ? {} : { data })
  }
}

// flatten lists a forest depth-first, parent before child. GET /agents is this listing rather than
// the raw lane list because `parent` is a fact of the forest and only treeOf can see it
// (projections.ts, summaryOf).
const flatten = (nodes: ReadonlyArray<AgentNode>): ReadonlyArray<AgentSummary> =>
  nodes.flatMap(({ children, ...summary }) => [summary, ...flatten(children)])

const findNode = (nodes: ReadonlyArray<AgentNode>, id: string): AgentNode | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found !== undefined) return found
  }
  return undefined
}

const logsOf = (entries: ReadonlyArray<{ readonly id: string; readonly events: ReadonlyArray<Event> }>) =>
  new Map(entries.map((entry) => [entry.id, entry.events] as const))

const frameOf = (seq: number, event: Event): string => `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`

// A comment frame: the client's parser drops it and the bytes keep the connection alive.
const HEARTBEAT = ": tardigrade\n\n"

// openTails counts the SSE tails this process holds. A tail is a fiber that outlives its request
// handler, so the count is what proves a disconnected client leaves nothing polling behind
// (api.test.ts, "a reconnect replays from Last-Event-ID and then runs live, once each": the tail is
// one while the client reads and zero once it aborts).
let openTails = 0

export const openStreams = (): number => openTails

// tail is the SSE body: replay from `from`, then follow. One pull answers with every event past the
// cursor, or, after `heartbeat` of silence, with a comment. The cursor is a count of events sent,
// which is also the seq of the last one, so a reconnect carrying Last-Event-ID resumes exactly
// where the dropped connection stopped and no event is sent twice (api.test.ts, "a reconnect
// replays from Last-Event-ID and then runs live").
//
// The fiber that polls is the stream's own, and the counter is taken back inside an
// acquireRelease, so the scope the response body ends closes the poll with it.
const tail = (
  read: (id: string) => Effect.Effect<ReadonlyArray<Event>>,
  id: string,
  from: number,
  poll: Duration.Input,
  heartbeat: Duration.Input
): Stream.Stream<Uint8Array> => {
  const pollMillis = Duration.toMillis(poll)
  const heartbeatMillis = Duration.toMillis(heartbeat)
  const step = (sent: number): Effect.Effect<readonly [string, number]> =>
    Effect.gen(function*() {
      let idle = 0
      for (;;) {
        const log = yield* read(id)
        if (log.length > sent) {
          const frames = log.slice(sent).map((event, i) => frameOf(sent + i + 1, event)).join("")
          return [frames, log.length] as const
        }
        yield* Effect.sleep(poll)
        idle += pollMillis
        if (idle >= heartbeatMillis) return [HEARTBEAT, sent] as const
      }
    })
  const frames = Stream.unfold(from, step)
  return Stream.unwrap(
    Effect.as(
      Effect.acquireRelease(
        Effect.sync(() => {
          openTails += 1
        }),
        () =>
          Effect.sync(() => {
            openTails -= 1
          })
      ),
      Stream.encodeText(frames)
    )
  )
}

// Deliver one message. The response is 202 whether the delivery started a turn or was absorbed as a
// redelivery: the host dedups by message id, so a retrying client gets the same answer and never
// learns it retried (host.test.ts, "redelivering one message id is absorbed").
const layerMessages = HttpRouter.add(
  "POST",
  "/agents/:id/messages",
  Effect.gen(function*() {
    const id = paramOf(yield* HttpRouter.params, "id")
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* Effect.catch(request.json, () => Effect.succeed<unknown>(undefined))
    const message = inboundOf(body)
    if (message === undefined) {
      return problem({
        status: 400,
        kind: "invalid-message",
        title: "Invalid Message",
        detail: "A message states an `id` (the dedup key, which becomes the turn id) and a `text`."
      })
    }
    const agents = yield* Agents
    return HttpServerResponse.jsonUnsafe(yield* agents.deliver(id, message), { status: 202 })
  })
)

const layerList = HttpRouter.add(
  "GET",
  "/agents",
  Effect.gen(function*() {
    const agents = yield* Agents
    const forest = treeOf(logsOf(yield* agents.list()))
    return HttpServerResponse.jsonUnsafe(flatten(forest))
  })
)

const layerEvents = (limit: number) =>
  HttpRouter.add(
    "GET",
    "/agents/:id/events",
    Effect.gen(function*() {
      const id = paramOf(yield* HttpRouter.params, "id")
      const agents = yield* Agents
      const log = yield* agents.events(id)
      if (log.length === 0) return unknownAgent(id)
      const query = yield* HttpServerRequest.ParsedSearchParams
      const rawAfter = singleOf(query["after"])
      const after = integerOf(rawAfter)
      if (rawAfter !== undefined && after === undefined) return invalidQuery("after", rawAfter)
      const rawLimit = singleOf(query["limit"])
      const page = integerOf(rawLimit)
      if (rawLimit !== undefined && page === undefined) return invalidQuery("limit", rawLimit)
      const types = singleOf(query["types"])?.split(",").map((type) => type.trim()).filter((type) => type.length > 0)
      const rows: ReadonlyArray<EventRow> = log
        .map((event, index): EventRow => ({ seq: index + 1, event }))
        .filter((row) => row.seq > (after ?? 0) && (types === undefined || types.includes(row.event.type)))
        .slice(0, page ?? limit)
      return HttpServerResponse.jsonUnsafe(rows)
    })
  )

const layerStream = (poll: Duration.Input, heartbeat: Duration.Input) =>
  HttpRouter.add(
    "GET",
    "/agents/:id/events/stream",
    Effect.gen(function*() {
      const id = paramOf(yield* HttpRouter.params, "id")
      const agents = yield* Agents
      const log = yield* agents.events(id)
      if (log.length === 0) return unknownAgent(id)
      const query = yield* HttpServerRequest.ParsedSearchParams
      const rawAfter = singleOf(query["after"])
      const after = integerOf(rawAfter)
      if (rawAfter !== undefined && after === undefined) return invalidQuery("after", rawAfter)
      // Last-Event-ID is the browser's own resume and it wins: a reconnecting EventSource replays
      // the URL it was opened with, so the query would otherwise take the stream back to where the
      // first connection began.
      const request = yield* HttpServerRequest.HttpServerRequest
      const from = integerOf(request.headers["last-event-id"]) ?? after ?? 0
      return HttpServerResponse.stream(tail(agents.events, id, from, poll, heartbeat), {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" }
      })
    })
  )

const layerTurns = HttpRouter.add(
  "GET",
  "/agents/:id/turns",
  Effect.gen(function*() {
    const id = paramOf(yield* HttpRouter.params, "id")
    const agents = yield* Agents
    const log = yield* agents.events(id)
    if (log.length === 0) return unknownAgent(id)
    const query = yield* HttpServerRequest.ParsedSearchParams
    const rawAt = singleOf(query["at"])
    const at = integerOf(rawAt)
    if (rawAt !== undefined && at === undefined) return invalidQuery("at", rawAt)
    // `at` is a seq, and a seq is a 1-based position, so `at` events stand before the cut and the
    // prefix length is the seq itself (projections.ts, turnsOf).
    return HttpServerResponse.jsonUnsafe(turnsOf(log, at))
  })
)

const layerTurn = HttpRouter.add(
  "GET",
  "/agents/:id/turns/:turn",
  Effect.gen(function*() {
    const params = yield* HttpRouter.params
    const id = paramOf(params, "id")
    const turn = paramOf(params, "turn")
    const agents = yield* Agents
    const log = yield* agents.events(id)
    if (log.length === 0) return unknownAgent(id)
    const view = turnsOf(log).find((candidate) => candidate.turn === turn)
    if (view === undefined) {
      return problem({
        status: 404,
        kind: "unknown-turn",
        title: "Unknown Turn",
        detail: `Agent ${JSON.stringify(id)} was never asked to serve a turn named ${JSON.stringify(turn)}.`
      })
    }
    return HttpServerResponse.jsonUnsafe(view)
  })
)

const layerResume = HttpRouter.add(
  "POST",
  "/agents/:id/turns/:turn/resume",
  Effect.gen(function*() {
    const params = yield* HttpRouter.params
    const id = paramOf(params, "id")
    const turn = paramOf(params, "turn")
    const agents = yield* Agents
    // The library's guard is the API's 409: a turn resumes only from a failed active epoch, and its
    // refusal carries the reason a caller acts on (host.ts, ResumeRefused).
    return yield* agents.resume(id, turn).pipe(
      Effect.as(HttpServerResponse.jsonUnsafe({ agent: id, turn }, { status: 202 })),
      Effect.catch((refused) =>
        Effect.succeed(
          problem({ status: 409, kind: "resume-refused", title: "Resume Refused", detail: refused.detail })
        )
      )
    )
  })
)

const layerTree = HttpRouter.add(
  "GET",
  "/agents/:id/tree",
  Effect.gen(function*() {
    const id = paramOf(yield* HttpRouter.params, "id")
    const agents = yield* Agents
    // The forest is built over every log because parentage is a claim in the PARENT's log; a
    // subtree cannot be derived from the subtree's own events (projections.ts, treeOf).
    const node = findNode(treeOf(logsOf(yield* agents.list())), id)
    if (node === undefined) return unknownAgent(id)
    return HttpServerResponse.jsonUnsafe(node)
  })
)

// layerApi is every agent endpoint, merged into whichever router builds it. It carries no gate of
// its own: the bearer middleware is global to the router, so a route is inside it by being part of
// the same application (http.ts, layerAuth; http.test.ts, "a token closes the API and leaves
// healthz open").
export const layerApi = (options: ApiOptions = {}) =>
  Layer.mergeAll(
    layerMessages,
    layerList,
    layerEvents(options.limit ?? DEFAULT_EVENT_LIMIT),
    layerStream(options.poll ?? DEFAULT_SSE_POLL, options.heartbeat ?? DEFAULT_SSE_HEARTBEAT),
    layerTurns,
    layerTurn,
    layerResume,
    layerTree
  )
