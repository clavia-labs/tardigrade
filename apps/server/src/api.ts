import { Duration, Effect, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, type HttpApiEndpoint } from "effect/unstable/httpapi"
import type { Event } from "@clavia/tardigrade-core/event"

import {
  Api,
  apiOf,
  invalidRequest,
  RESERVED_ACTOR,
  ResumeRefused,
  unacceptableField,
  UnknownActor,
  UnknownProjection,
  UnknownThread,
  UnknownTurn,
  type ProjectionDeclaration,
  type ThreadNode
} from "@clavia/tardigrade-client/contract"
import { agentProjections, turnViewsOf } from "./actor"
import { Threads } from "./host"
import { problemResponse } from "./problem"
import { treeOf, type ThreadSummary } from "./projections"

// The thread endpoints. A route is a lookup on the Threads service plus one projection, because the
// read side is a pure function of a log (projections.ts) and the write side is one delivery
// (host.ts). What each route accepts and answers is declared in contract.ts; this module is the
// implementation of that declaration. Nothing here holds state between requests: the SSE tail keeps
// a cursor for the connection it serves and nothing else, so two processes reading the same log
// answer the same way.

// The page size of GET /v1/actors/:actor/threads/:id/events when the caller states no `limit`
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

const unknownThreadDetail = (id: string) => `No thread named ${JSON.stringify(id)} has ever existed.`

const unknownActorDetail = (actor: string) =>
  `This server serves one actor, ${JSON.stringify(RESERVED_ACTOR)}, and nothing named ${JSON.stringify(actor)}.`

// actorOf is the guard every declared route runs first. The actor level is a path parameter so the
// declaration states the shape a deploy will vary (contract.ts, RESERVED_ACTOR), and this build
// serves exactly the reserved name: any other is code nobody deployed here, which is its own 404
// rather than an empty listing (api.test.ts, "an actor nobody deployed is its own 404").
const actorOf = (actor: string): Effect.Effect<string, ReturnType<typeof UnknownActor.of>> =>
  actor === RESERVED_ACTOR ? Effect.succeed(actor) : Effect.fail(UnknownActor.of(unknownActorDetail(actor)))

// logOf reads a thread's events, failing the route when the log is empty. A thread exists once its
// log has an event (docs/how-to/server.md, "Creation is delivery"), so an empty log is the only
// unknown thread there is.
const logOf = (read: (id: string) => Effect.Effect<ReadonlyArray<Event>>, id: string) =>
  Effect.flatMap(read(id), (log) =>
    log.length === 0 ? Effect.fail(UnknownThread.of(unknownThreadDetail(id))) : Effect.succeed(log))

// flatten lists a forest depth-first, parent before child. The threads listing is this rather than
// the raw lane list because `parent` is a fact of the forest and only treeOf can see it
// (projections.ts, summaryOf).
const flatten = (nodes: ReadonlyArray<ThreadNode>): ReadonlyArray<ThreadSummary> =>
  nodes.flatMap(({ children, ...summary }) => [summary, ...flatten(children)])

const findNode = (nodes: ReadonlyArray<ThreadNode>, id: string): ThreadNode | undefined => {
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
    "/v1/actors/:actor/threads/:id/events/stream",
    Effect.gen(function*() {
      const params = yield* HttpRouter.params
      const actor = paramOf(params, "actor")
      // The tail answers the same actor guard the declared routes do. It is spelled out rather than
      // shared with them because this route decodes its own request: it is not a declared endpoint
      // (contract.ts, the SSE note; api.test.ts, "the tail refuses an actor nobody deployed").
      if (actor !== RESERVED_ACTOR) return problemResponse(UnknownActor.of(unknownActorDetail(actor)))
      const id = paramOf(params, "id")
      const threads = yield* Threads
      const log = yield* threads.events(id)
      if (log.length === 0) return problemResponse(UnknownThread.of(unknownThreadDetail(id)))
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
      return HttpServerResponse.stream(tail(threads.events, id, from, poll, heartbeat), {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" }
      })
    })
  )
}

// layerThreadsGroup implements every declared thread endpoint over the Threads service and the
// projections. It carries no gate of its own: the bearer middleware is global to the router, so a
// route is inside it by being part of the same application (http.ts, layerAuth; http.test.ts, "a
// token closes the API and leaves healthz open").
export const layerThreadsGroup = (options: ApiOptions = {}) => {
  const limit = options.limit ?? DEFAULT_EVENT_LIMIT
  return HttpApiBuilder.group(Api, "threads", (handlers) =>
    handlers
      // The body is the declared payload, decoded before this runs: a body that is not one is
      // refused by the declaration and rendered as a problem document (contract.ts,
      // layerRequestProblems), so the handler only ever sees a message.
      .handle("deliver", ({ params, payload }) =>
        Effect.gen(function*() {
          const actor = yield* actorOf(params.actor)
          const threads = yield* Threads
          const accepted = yield* threads.deliver(params.id, payload)
          return { actor, ...accepted }
        }))
      .handle("list", ({ params }) =>
        Effect.gen(function*() {
          yield* actorOf(params.actor)
          const threads = yield* Threads
          return flatten(treeOf(logsOf(yield* threads.list())))
        }))
      .handle("events", ({ params, query }) =>
        Effect.gen(function*() {
          yield* actorOf(params.actor)
          const threads = yield* Threads
          const log = yield* logOf(threads.events, params.id)
          const { after, limit: page } = query
          // The comma list is the one rule the query Schema does not state: every value it could
          // hold is a valid event type, including ones this build has never seen.
          const types = query.types?.split(",").map((type) => type.trim()).filter((type) => type.length > 0)
          return log
            .map((event, index) => ({ seq: index + 1, event }))
            .filter((row) => row.seq > (after ?? 0) && (types === undefined || types.includes(row.event.type)))
            .slice(0, page ?? limit)
        }))
      .handle("turn", ({ params }) =>
        Effect.gen(function*() {
          yield* actorOf(params.actor)
          const threads = yield* Threads
          const log = yield* logOf(threads.events, params.id)
          const view = turnViewsOf(log).find((candidate) => candidate.turn === params.turn)
          if (view === undefined) {
            return yield* Effect.fail(
              UnknownTurn.of(
                `Thread ${JSON.stringify(params.id)} was never asked to serve a turn named ${
                  JSON.stringify(params.turn)
                }.`
              )
            )
          }
          return view
        }))
      .handle("resume", ({ params }) =>
        Effect.gen(function*() {
          const actor = yield* actorOf(params.actor)
          const threads = yield* Threads
          return yield* threads.resume(params.id, params.turn).pipe(
            Effect.as({ actor, thread: params.id, turn: params.turn }),
            Effect.catch((refused) => Effect.fail(ResumeRefused.of(refused.detail)))
          )
        }))
      .handle("tree", ({ params }) =>
        Effect.gen(function*() {
          yield* actorOf(params.actor)
          const threads = yield* Threads
          // The forest is built over every log because parentage is a claim in the PARENT's log; a
          // subtree cannot be derived from the subtree's own events (projections.ts, treeOf).
          const node = findNode(treeOf(logsOf(yield* threads.list())), params.id)
          if (node === undefined) {
            return yield* Effect.fail(UnknownThread.of(unknownThreadDetail(params.id)))
          }
          return node
        })))
}

// ServerApi is the surface this process serves: the platform's log routes plus the projections the
// actor it mounts declares (actor.ts, agentProjections). The OpenAPI document and the reference
// page are derived from this value, so a projection appears in both by being declared.
export const ServerApi = apiOf(agentProjections)

// layerProjectionsGroup implements every declared projection the same way, because there is only
// one way: read the thread's log, hand it to `run` with the decoded query, and answer what comes
// back. Nothing about a projection's meaning reaches this module; the actor holds all of it.
// readOf is the whole of what serving a projection is: refuse an actor this build does not serve,
// read the thread's log, and hand it to `run` with the decoded query. Nothing about what a
// projection means reaches this module; the actor holds all of it (actor.ts, agentProjections).
const readOf = (declaration: ProjectionDeclaration) =>
(request: {
  readonly params: { readonly actor: string; readonly id: string }
  readonly query: never
}) =>
  Effect.gen(function*() {
    yield* actorOf(request.params.actor)
    const threads = yield* Threads
    const log = yield* logOf(threads.events, request.params.id)
    return declaration.run(log, request.query)
  })

export const layerProjectionsGroup = () =>
  HttpApiBuilder.group(ServerApi, "projections", (handlers) => {
    // Every declared name gets the same handler, built from the same record the endpoints were
    // generated from, so the two cannot disagree about which names exist. The type is the group's
    // own endpoint map with every key required: `handleAll` accepts a partial record, and a partial
    // one would leave the group short a handler at run time (api.test.ts, "a declared projection
    // serves what the actor computes").
    type Endpoints = (typeof handlers)["~EndpointsByIdentifier"]
    type Complete = {
      readonly [Name in keyof Endpoints]: HttpApiEndpoint.Handler<
        Endpoints[Name],
        HttpApiEndpoint.MiddlewareError<Endpoints[Name]>,
        Threads
      >
    }
    const served = Object.fromEntries(
      Object.entries(agentProjections).map(([name, declaration]) => [name, readOf(declaration)])
    ) as unknown as Complete
    return handlers.handleAll(served)
  })

// The name a request asked for, when the actor never declared it. The declared names are literal
// paths, and a literal segment beats a parameter in this router, so this route is reached only by a
// name that matched nothing (api.test.ts, "a name the actor never declared says what does exist").
// `events` and `stream` never reach here either, for the same reason: they are the log's own routes.
export const layerUnknownProjection = () => {
  const declared = Object.keys(agentProjections)
  const detail = declared.length === 0
    ? "This actor declares no projections."
    : `This actor declares ${declared.map((name) => JSON.stringify(name)).join(", ")}.`
  return HttpRouter.add(
    "GET",
    "/v1/actors/:actor/threads/:id/:name",
    Effect.gen(function*() {
      const params = yield* HttpRouter.params
      const actor = paramOf(params, "actor")
      if (actor !== RESERVED_ACTOR) return problemResponse(UnknownActor.of(unknownActorDetail(actor)))
      const name = paramOf(params, "name")
      return problemResponse(
        UnknownProjection.of(`No projection named ${JSON.stringify(name)} is mounted here. ${detail}`)
      )
    })
  )
}
