import { Duration, Effect, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { Event } from "@clavia/tardigrade-core/event"

import {
  Api,
  invalidRequest,
  ResumeRefused,
  unacceptableField,
  UnknownAgent,
  UnknownTurn,
  type AgentNode
} from "@clavia/tardigrade-client/contract"
import { Agents } from "./host"
import { problemResponse } from "./problem"
import { treeOf, turnsOf, type AgentSummary } from "./projections"

// The agent endpoints. A route is a lookup on the Agents service plus one projection, because the
// read side is a pure function of a log (projections.ts) and the write side is one delivery
// (host.ts). What each route accepts and answers is declared in contract.ts; this module is the
// implementation of that declaration. Nothing here holds state between requests: the SSE tail keeps
// a cursor for the connection it serves and nothing else, so two processes reading the same log
// answer the same way.

// The page size of GET /agents/:id/events when the caller states no `limit`
// (docs/how-to/server.md, "Endpoints").
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

const paramOf = (params: Readonly<Record<string, string | undefined>>, name: string): string =>
  params[name] ?? ""

const singleOf = (value: string | ReadonlyArray<string> | undefined): string | undefined =>
  value === undefined ? undefined : typeof value === "string" ? value : value[0]

// A sequence number is a whole number at or above zero. The declared endpoints get this from their
// query Schema (contract.ts, Seq); the stream is not a declared endpoint, so it reads its own.
const integerOf = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

const unknownAgentDetail = (id: string) => `No agent named ${JSON.stringify(id)} has ever existed.`

// logOf reads an agent's events, failing the route when the log is empty. An agent exists once its
// log has an event (docs/how-to/server.md, "Creation is delivery"), so an empty log is the only
// unknown agent there is.
const logOf = (read: (id: string) => Effect.Effect<ReadonlyArray<Event>>, id: string) =>
  Effect.flatMap(read(id), (log) =>
    log.length === 0 ? Effect.fail(UnknownAgent.of(unknownAgentDetail(id))) : Effect.succeed(log))

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

// The stream stays an HttpRouter route rather than an HttpApi endpoint. HttpApi is
// request-and-response shaped: an endpoint decodes a request, runs a handler, and encodes one
// answer, while this route hands back a connection that outlives the handler and carries its own
// cursor, heartbeat, and Last-Event-ID resume. It is merged beside the HttpApi app and inherits the
// same bearer gate by being part of the same router (http.ts, layerApp).
export const layerStream = (options: ApiOptions = {}) => {
  const poll = options.poll ?? DEFAULT_SSE_POLL
  const heartbeat = options.heartbeat ?? DEFAULT_SSE_HEARTBEAT
  return HttpRouter.add(
    "GET",
    "/agents/:id/events/stream",
    Effect.gen(function*() {
      const id = paramOf(yield* HttpRouter.params, "id")
      const agents = yield* Agents
      const log = yield* agents.events(id)
      if (log.length === 0) return problemResponse(UnknownAgent.of(unknownAgentDetail(id)))
      const query = yield* HttpServerRequest.ParsedSearchParams
      const rawAfter = singleOf(query["after"])
      const after = integerOf(rawAfter)
      if (rawAfter !== undefined && after === undefined) {
        return problemResponse(invalidRequest("Query", [unacceptableField("after")]))
      }
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
}

// layerAgentsGroup implements every declared agent endpoint over the Agents service and the
// projections. It carries no gate of its own: the bearer middleware is global to the router, so a
// route is inside it by being part of the same application (http.ts, layerAuth; http.test.ts, "a
// token closes the API and leaves healthz open").
export const layerAgentsGroup = (options: ApiOptions = {}) => {
  const limit = options.limit ?? DEFAULT_EVENT_LIMIT
  return HttpApiBuilder.group(Api, "agents", (handlers) =>
    handlers
      // The body is the declared payload, decoded before this runs: a body that is not one is
      // refused by the declaration and rendered as a problem document (contract.ts,
      // layerRequestProblems), so the handler only ever sees a message.
      .handle("deliver", ({ params, payload }) =>
        Effect.gen(function*() {
          const agents = yield* Agents
          return yield* agents.deliver(params.id, payload)
        }))
      .handle("list", () =>
        Effect.gen(function*() {
          const agents = yield* Agents
          return flatten(treeOf(logsOf(yield* agents.list())))
        }))
      .handle("events", ({ params, query }) =>
        Effect.gen(function*() {
          const agents = yield* Agents
          const log = yield* logOf(agents.events, params.id)
          const { after, limit: page } = query
          // The comma list is the one rule the query Schema does not state: every value it could
          // hold is a valid event type, including ones this build has never seen.
          const types = query.types?.split(",").map((type) => type.trim()).filter((type) => type.length > 0)
          return log
            .map((event, index) => ({ seq: index + 1, event }))
            .filter((row) => row.seq > (after ?? 0) && (types === undefined || types.includes(row.event.type)))
            .slice(0, page ?? limit)
        }))
      .handle("turns", ({ params, query }) =>
        Effect.gen(function*() {
          const agents = yield* Agents
          const log = yield* logOf(agents.events, params.id)
          const { at } = query
          // `at` is a seq, and a seq is a 1-based position, so `at` events stand before the cut and
          // the prefix length is the seq itself (projections.ts, turnsOf).
          return turnsOf(log, at)
        }))
      .handle("turn", ({ params }) =>
        Effect.gen(function*() {
          const agents = yield* Agents
          const log = yield* logOf(agents.events, params.id)
          const view = turnsOf(log).find((candidate) => candidate.turn === params.turn)
          if (view === undefined) {
            return yield* Effect.fail(
              UnknownTurn.of(
                `Agent ${JSON.stringify(params.id)} was never asked to serve a turn named ${
                  JSON.stringify(params.turn)
                }.`
              )
            )
          }
          return view
        }))
      .handle("resume", ({ params }) =>
        Effect.gen(function*() {
          const agents = yield* Agents
          return yield* agents.resume(params.id, params.turn).pipe(
            Effect.as({ agent: params.id, turn: params.turn }),
            Effect.catch((refused) => Effect.fail(ResumeRefused.of(refused.detail)))
          )
        }))
      .handle("tree", ({ params }) =>
        Effect.gen(function*() {
          const agents = yield* Agents
          // The forest is built over every log because parentage is a claim in the PARENT's log; a
          // subtree cannot be derived from the subtree's own events (projections.ts, treeOf).
          const node = findNode(treeOf(logsOf(yield* agents.list())), params.id)
          if (node === undefined) {
            return yield* Effect.fail(UnknownAgent.of(unknownAgentDetail(params.id)))
          }
          return node
        })))
}
