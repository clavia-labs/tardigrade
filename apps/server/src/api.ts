import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, type HttpApiEndpoint } from "effect/unstable/httpapi"
import type { Event } from "@clavia/tardigrade-core/event"

import {
  Api,
  apiOf,
  InvalidRequest,
  invalidRequest,
  ModelCatalogUnavailable,
  RESERVED_ACTOR,
  unacceptableField,
  UnknownActor,
  UnknownMethod,
  UnknownMethodCall,
  UnknownProjection,
  UnknownThread,
  type ActorSummary,
  type ProjectionDeclaration,
  type ThreadNode
} from "@clavia/tardigrade-client/contract"
import { agentProjections } from "./actor"
import { ModelCatalogStore } from "./catalog"
import { modelsPageOf, providersPageOf } from "./catalog-page"
import { Threads, type ActorThreads } from "./host"
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
  `No actor named ${JSON.stringify(actor)} is available on this server.`

const unknownMethodDetail = (name: string, methods: Readonly<Record<string, unknown>>): string => {
  const declared = Object.keys(methods)
  const available = declared.length === 0
    ? "This actor declares no methods."
    : `This actor declares ${declared.map((method) => JSON.stringify(method)).join(", ")}.`
  return `No method named ${JSON.stringify(name)} is declared. ${available}`
}

const failureMessage = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure)

// actorOf is the guard every declared route runs first. The actor level is a path parameter so the
// declaration states the shape a deploy will vary (contract.ts, RESERVED_ACTOR), and this build
// serves exactly the reserved name: any other is code nobody deployed here, which is its own 404
// rather than an empty listing (api.test.ts, "an actor nobody deployed is its own 404").
const actorOf = (actor: string): Effect.Effect<ActorThreads, ReturnType<typeof UnknownActor.of>, Threads> =>
  Effect.flatMap(Threads, (threads) => {
    const selected = actor === RESERVED_ACTOR ? Effect.succeed(threads) : (threads.actor?.(actor) ?? Effect.void)
    return Effect.flatMap(selected, (found) => found === undefined
      ? Effect.fail(UnknownActor.of(unknownActorDetail(actor)))
      : Effect.succeed(found))
  })

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
      const id = paramOf(params, "id")
      const registry = yield* Threads
      const threads = actor === RESERVED_ACTOR
        ? registry
        : (yield* (registry.actor?.(actor) ?? Effect.void))
      if (threads === undefined) return problemResponse(UnknownActor.of(unknownActorDetail(actor)))
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
      // layerRequestProblems), so the handler only ever sees an event.
      .handle("append", ({ params, payload }) =>
        Effect.gen(function*() {
          const threads = yield* actorOf(params.actor)
          yield* threads.append(params.id, payload)
          return { actor: params.actor, thread: params.id }
        }))
      .handle("list", ({ params }) =>
        Effect.gen(function*() {
          const threads = yield* actorOf(params.actor)
          return flatten(treeOf(logsOf(yield* threads.list)))
        }))
      .handle("events", ({ params, query }) =>
        Effect.gen(function*() {
          const threads = yield* actorOf(params.actor)
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
      .handle("tree", ({ params }) =>
        Effect.gen(function*() {
          const threads = yield* actorOf(params.actor)
          // The forest is built over every log because parentage is a claim in the PARENT's log; a
          // subtree cannot be derived from the subtree's own events (projections.ts, treeOf).
          const node = findNode(treeOf(logsOf(yield* threads.list)), params.id)
          if (node === undefined) {
            return yield* Effect.fail(UnknownThread.of(unknownThreadDetail(params.id)))
          }
          return node
        })))
}

// ServerApi is the surface this process serves: the platform's log routes, actor methods, and declared projections.
export const ServerApi = apiOf(agentProjections)

// jsonSchemaOf attaches every generated definition to the root schema that references it.
const jsonSchemaOf = (schema: Schema.Constraint): unknown => {
  const document = Schema.toJsonSchemaDocument(schema)
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions }
}

const methodOf = (threads: ActorThreads, name: string) => {
  const method = threads.methods[name]
  return method === undefined
    ? Effect.fail(UnknownMethod.of(unknownMethodDetail(name, threads.methods)))
    : Effect.succeed(method)
}

// layerMethodsGroup invokes and reads the method declarations carried by the selected actor runtime.
export const layerMethodsGroup = HttpApiBuilder.group(ServerApi, "methods", (handlers) =>
  handlers
    .handle("methods", ({ params }) =>
      Effect.map(actorOf(params.actor), (threads) =>
        Object.entries(threads.methods).map(([name, method]) => ({
          name,
          inputSchema: jsonSchemaOf(method.input),
          outputSchema: jsonSchemaOf(method.output)
        }))))
    .handle("invoke", ({ params, payload }) =>
      Effect.gen(function*() {
        const threads = yield* actorOf(params.actor)
        const method = yield* methodOf(threads, params.method)
        const at = yield* Clock.currentTimeMillis
        const event = yield* Effect.try({
          try: () => method.eventOf({ id: params.call, input: payload, at }),
          catch: (failure) => InvalidRequest.of(
            `The input for method ${JSON.stringify(params.method)} is invalid. ${failureMessage(failure)}`
          )
        })
        yield* threads.append(params.id, event)
        return { actor: params.actor, thread: params.id, method: params.method, call: params.call }
      }))
    .handle("methodState", ({ params }) =>
      Effect.gen(function*() {
        const threads = yield* actorOf(params.actor)
        const method = yield* methodOf(threads, params.method)
        const log = yield* logOf(threads.events, params.id)
        const state = method.state(log, params.call)
        if (state === undefined) {
          return yield* Effect.fail(
            UnknownMethodCall.of(
              `No call named ${JSON.stringify(params.call)} exists for method ${JSON.stringify(params.method)} on this thread.`
            )
          )
        }
        return state
      })))

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
    const threads = yield* actorOf(request.params.actor)
    const log = yield* logOf(threads.events, request.params.id)
    return declaration.run(log, request.query)
  })

export const layerProjectionsGroup = HttpApiBuilder.group(ServerApi, "projections", (handlers) => {
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

// The name a request asked for when the actor never declared it.
const declaredProjections = Object.keys(agentProjections)
const declaredDetail = declaredProjections.length === 0
  ? "This actor declares no projections."
  : `This actor declares ${declaredProjections.map((name) => JSON.stringify(name)).join(", ")}.`

export const layerUnknownProjection = HttpRouter.add(
  "GET",
  "/v1/actors/:actor/threads/:id/projections/:name",
  Effect.gen(function*() {
    const params = yield* HttpRouter.params
    const actor = paramOf(params, "actor")
    const registry = yield* Threads
    if (actor !== RESERVED_ACTOR && (yield* (registry.actor?.(actor) ?? Effect.void)) === undefined) {
      return problemResponse(UnknownActor.of(unknownActorDetail(actor)))
    }
    const name = paramOf(params, "name")
    return problemResponse(
      UnknownProjection.of(`No projection named ${JSON.stringify(name)} is mounted here. ${declaredDetail}`)
    )
  })
)

export const layerActorsGroup = HttpApiBuilder.group(ServerApi, "actors", (handlers) =>
  handlers
    .handle("actors", () =>
      Effect.flatMap(Threads, (threads): Effect.Effect<ReadonlyArray<ActorSummary>> =>
        threads.actors ?? Effect.succeed([{ name: RESERVED_ACTOR, builtIn: true }])))
    .handle("pushActor", ({ payload }) =>
      Effect.gen(function*() {
        const threads = yield* Threads
        if (threads.push === undefined) {
          return yield* Effect.fail(InvalidRequest.of("This server does not accept actor pushes."))
        }
        return yield* Effect.mapError(threads.push(payload), (error) => InvalidRequest.of(error.message))
      })))

const catalogSnapshot = Effect.flatMap(ModelCatalogStore, (catalog) =>
  catalog.snapshot === undefined
    ? Effect.fail(ModelCatalogUnavailable.of(
      "No validated model catalog is available. Check the server startup logs and catalog configuration."
    ))
    : Effect.succeed(catalog.snapshot))

// layerModelsGroup pages the process snapshot and never reads the private provider directory.
export const layerModelsGroup = HttpApiBuilder.group(ServerApi, "models", (handlers) =>
  handlers
    .handle("providers", ({ query }) => Effect.flatMap(catalogSnapshot, (catalog) =>
      Effect.try({
        try: () => providersPageOf(catalog, query),
        catch: (error) => InvalidRequest.of(failureMessage(error))
      })))
    .handle("models", ({ query }) => Effect.flatMap(catalogSnapshot, (catalog) =>
      Effect.try({
        try: () => modelsPageOf(catalog, query),
        catch: (error) => InvalidRequest.of(failureMessage(error))
      }))))
