import { Clock, Context, Duration, Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, type HttpApiEndpoint } from "effect/unstable/httpapi"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { invokedEventOf } from "@clavia/tardigrade-core/communication/envelope"
import {
  actorMethodTimeoutOf,
  actorInvocationContextFrom,
  cancellationRequested,
  cancellationDispositionOf,
  cancellationRequestIdOf
} from "@clavia/tardigrade-core/actor/method"

import {
  Api,
  apiOf,
  InvalidRequest,
  InvocationSettled,
  invalidRequest,
  ModelCatalogUnavailable,
  RESERVED_ACTOR,
  unacceptableField,
  UnknownMethod,
  UnknownMethodCall,
  UnknownActor,
  UnknownProjection,
  UnknownThread,
  type ActorSummary,
  type ThreadChanged,
  type ThreadsSnapshot,
  type ProjectionDeclaration,
  type ThreadNode
} from "@clavia/tardigrade-client/contract"
import { agentProjections } from "./actor"
import { ModelCatalogStore } from "./catalog"
import { providerAvailabilitiesOf } from "./catalog-availability"
import { modelsPageOf, providersPageOf } from "./catalog-page"
import { ServerConfig } from "./config"
import { idOf, Threads, type ActorThreads } from "./host"
import { problemResponse } from "./problem"
import { treeOf, type ThreadSummary } from "./projections"

// The thread endpoints. A route is a lookup on the Threads service plus one projection, because the
// read side is a pure function of a log (projections.ts) and the write side is one delivery
// (host.ts). What each route accepts and answers is declared in contract.ts; this module is the
// implementation of that declaration. Nothing here holds state between requests: the SSE tail keeps
// a cursor for the connection it serves and nothing else, so two processes reading the same log
// answer the same way.

// The page size of GET /v1/threads/:id/events when the caller states no `limit`
// (docs/how-to/server.md, "Endpoints").
export const DEFAULT_EVENT_LIMIT = 200

// How long an idle tail waits before writing a comment frame. A proxy between the client and this
// process closes a connection that says nothing, and a comment is the cheapest thing to say.
export const DEFAULT_SSE_HEARTBEAT = Duration.seconds(5)

export interface ApiOptions {
  readonly limit?: number
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
const unknownActorDetail = (id: string) => `No actor instance named ${JSON.stringify(id)} has ever existed.`

const actorOf = (threads: Context.Service.Shape<typeof Threads>, id: string) =>
  Effect.flatMap(threads.instance(id), (actor) =>
    actor === undefined ? Effect.fail(UnknownActor.of(unknownActorDetail(id))) : Effect.succeed(actor))

const unknownMethodDetail = (name: string, methods: Readonly<Record<string, unknown>>): string => {
  const declared = Object.keys(methods)
  const available = declared.length === 0
    ? "This actor declares no methods."
    : `This actor declares ${declared.map((method) => JSON.stringify(method)).join(", ")}.`
  return `No method named ${JSON.stringify(name)} is declared. ${available}`
}

const failureMessage = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure)

// logOf reads a thread's events, failing the route when the log is empty. A thread exists once its
// log has an event (docs/how-to/server.md, "Creation is delivery"), so an empty log is the only
// unknown thread there is.
const logOf = (read: (id: string) => Effect.Effect<ReadonlyArray<Event>>, id: string) =>
  Effect.flatMap(read(id), (log) =>
    log.length === 0 ? Effect.fail(UnknownThread.of(unknownThreadDetail(id))) : Effect.succeed(log))

// flatten lists a forest depth-first, parent before child. The threads listing is this rather than
// the raw thread list because `parent` is a fact of the forest and only treeOf can see it
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

const rosterOf = (threads: ActorThreads) =>
  Effect.map(threads.list, (entries) => flatten(treeOf(logsOf(entries))))

const frameOf = (seq: number, event: unknown): string => `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`

// A comment frame: the client's parser drops it and the bytes keep the connection alive.
const HEARTBEAT = ": tardigrade\n\n"

// openTails counts the SSE tails this process holds. A tail is a fiber that outlives its request
// handler, so the count is what proves a disconnected client leaves nothing polling behind
// (api.test.ts, "a reconnect replays from Last-Event-ID and then runs live, once each": the tail is
// one while the client reads and zero once it aborts).
let openTails = 0

export const openStreams = (): number => openTails

// tail is the SSE body: replay from `from`, then wait for the thread head to advance. The durable
// sequence is both the page cursor and the SSE id, so Last-Event-ID resumes without duplication
// (api.test.ts, "a reconnect replays from Last-Event-ID and then runs live, once each").
const tail = (
  readPage: ActorThreads["eventsPage"],
  awaitHead: ActorThreads["awaitHead"],
  id: string,
  from: number,
  limit: number,
  heartbeat: Duration.Input
): Stream.Stream<Uint8Array> => {
  interface State {
    readonly cursor: number
    readonly target?: number
  }
  const step = (state: State): Effect.Effect<readonly [string, State]> =>
    Effect.gen(function*() {
      let current = state
      for (;;) {
        if (current.target !== undefined && current.cursor >= current.target) {
          const wake = yield* Effect.race(
            Effect.map(awaitHead(id, current.cursor), (target) => ({ kind: "commit" as const, target })),
            Effect.as(Effect.sleep(heartbeat), { kind: "heartbeat" as const })
          )
          if (wake.kind === "heartbeat") return [HEARTBEAT, current] as const
          current = { cursor: current.cursor, target: wake.target }
        }
        const page = yield* readPage(id, current.cursor, limit)
        if (page.length > 0) {
          const frames = page.map(({ seq, event }) => frameOf(seq, event)).join("")
          const cursor = page[page.length - 1]!.seq
          const target = current.target ?? (page.length < limit ? cursor : undefined)
          return [frames, { cursor, ...(target === undefined ? {} : { target }) }] as const
        }
        const waiting = { cursor: current.cursor, target: current.cursor }
        const wake = yield* Effect.race(
          Effect.map(awaitHead(id, current.cursor), (target) => ({ kind: "commit" as const, target })),
          Effect.as(Effect.sleep(heartbeat), { kind: "heartbeat" as const })
        )
        if (wake.kind === "heartbeat") return [HEARTBEAT, waiting] as const
        current = { cursor: current.cursor, target: wake.target }
      }
    })
  const frames = Stream.unfold({ cursor: from } as State, step)
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

const actorTail = (
  threads: ActorThreads,
  from: number | undefined,
  limit: number,
  heartbeat: Duration.Input
): Stream.Stream<Uint8Array> => {
  interface State {
    readonly cursor: number
    readonly initial: boolean
    readonly handshake: boolean
  }
  const snapshot = (seq: number, summaries: ReadonlyArray<ThreadSummary>): string =>
    frameOf(seq, { type: "ThreadsSnapshot", threads: summaries } satisfies ThreadsSnapshot)
  const step = (state: State): Effect.Effect<readonly [string, State]> =>
    Effect.gen(function*() {
      if (state.initial) {
        const cursor = yield* threads.actorHead
        return [snapshot(cursor, yield* rosterOf(threads)), { cursor, initial: false, handshake: false }] as const
      }
      if (state.handshake) return [HEARTBEAT, { ...state, handshake: false }] as const
      const page = yield* threads.actorEventsPage(state.cursor, limit)
      if (page.length > 0) {
        const summaries = yield* rosterOf(threads)
        const byId = new Map(summaries.map((summary) => [summary.id, summary] as const))
        const frames = page.flatMap(({ seq, event }) => {
          if (event.type !== "ThreadCommitted" || typeof event.thread !== "string") return []
          const id = idOf(event.thread) ?? event.thread
          const thread = byId.get(id)
          return thread === undefined ? [] : [frameOf(seq, { type: "ThreadChanged", thread } satisfies ThreadChanged)]
        }).join("")
        const cursor = page[page.length - 1]!.seq
        return [frames === "" ? HEARTBEAT : frames, { cursor, initial: false, handshake: false }] as const
      }
      const wake = yield* Effect.race(
        Effect.map(threads.awaitActorHead(state.cursor), (cursor) => ({ kind: "commit" as const, cursor })),
        Effect.as(Effect.sleep(heartbeat), { kind: "heartbeat" as const })
      )
      if (wake.kind === "heartbeat") return [HEARTBEAT, state] as const
      return [HEARTBEAT, { cursor: state.cursor, initial: false, handshake: false }] as const
    })
  const frames = Stream.unfold({ cursor: from ?? 0, initial: from === undefined, handshake: from !== undefined } as State, step)
  return Stream.unwrap(
    Effect.as(
      Effect.acquireRelease(
        Effect.sync(() => {
          openTails += 1
        }),
        () => Effect.sync(() => {
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
const streamResponse = (
  threads: ActorThreads,
  id: string,
  limit: number,
  heartbeat: Duration.Input
) => Effect.gen(function*() {
  const first = yield* threads.eventsPage(id, 0, 1)
  if (first.length === 0) return problemResponse(UnknownThread.of(unknownThreadDetail(id)))
  const query = yield* HttpServerRequest.ParsedSearchParams
  const rawAfter = singleOf(query["after"])
  const after = integerOf(rawAfter)
  if (rawAfter !== undefined && after === undefined) {
    return problemResponse(invalidRequest("Query", [unacceptableField("after")]))
  }
  const request = yield* HttpServerRequest.HttpServerRequest
  const from = integerOf(request.headers["last-event-id"]) ?? after ?? 0
  return HttpServerResponse.stream(tail(threads.eventsPage, threads.awaitHead, id, from, limit, heartbeat), {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache" }
  })
})

const actorStreamResponse = (
  threads: ActorThreads,
  limit: number,
  heartbeat: Duration.Input
) => Effect.gen(function*() {
  const query = yield* HttpServerRequest.ParsedSearchParams
  const rawAfter = singleOf(query["after"])
  const after = integerOf(rawAfter)
  if (rawAfter !== undefined && after === undefined) {
    return problemResponse(invalidRequest("Query", [unacceptableField("after")]))
  }
  const request = yield* HttpServerRequest.HttpServerRequest
  const rawLastEventId = request.headers["last-event-id"]
  const lastEventId = integerOf(rawLastEventId)
  if (rawLastEventId !== undefined && lastEventId === undefined) {
    return problemResponse(invalidRequest("Headers", [unacceptableField("last-event-id")]))
  }
  return HttpServerResponse.stream(actorTail(threads, lastEventId ?? after, limit, heartbeat), {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache" }
  })
})

export const layerStream = (options: ApiOptions = {}) => {
  const limit = options.limit ?? DEFAULT_EVENT_LIMIT
  const heartbeat = options.heartbeat ?? DEFAULT_SSE_HEARTBEAT
  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/v1/actors/:id/threads/:thread/events/stream",
      Effect.gen(function*() {
        const params = yield* HttpRouter.params
        const service = yield* Threads
        const threads = yield* actorOf(service, paramOf(params, "id"))
        return yield* streamResponse(threads, paramOf(params, "thread"), limit, heartbeat)
      })
    ),
    HttpRouter.add(
      "GET",
      "/v1/actors/:id/events/stream",
      Effect.gen(function*() {
        const params = yield* HttpRouter.params
        const service = yield* Threads
        const threads = yield* service.ensure(paramOf(params, "id"))
        return yield* actorStreamResponse(threads, limit, heartbeat)
      })
    )
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
          const service = yield* Threads
          const threads = yield* service.ensure(params.id)
          yield* threads.append(params.thread, payload)
          return { actor: params.id, thread: params.thread }
        }))
      .handle("list", ({ params }) =>
        Effect.gen(function*() {
          const threads = yield* actorOf(yield* Threads, params.id)
          return yield* rosterOf(threads)
        }))
      .handle("events", ({ params, query }) =>
        Effect.gen(function*() {
          const threads = yield* actorOf(yield* Threads, params.id)
          const log = yield* logOf(threads.events, params.thread)
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
          const threads = yield* actorOf(yield* Threads, params.id)
          // The forest is built over every log because parentage is a claim in the PARENT's log; a
          // subtree cannot be derived from the subtree's own events (projections.ts, treeOf).
          const node = findNode(treeOf(logsOf(yield* threads.list)), params.thread)
          if (node === undefined) {
            return yield* Effect.fail(UnknownThread.of(unknownThreadDetail(params.thread)))
          }
          return node
        })))
}

// layerRuntimeGroup describes the actor mounted at the runtime origin.
export const layerRuntimeGroup = HttpApiBuilder.group(Api, "runtime", (handlers) =>
  handlers.handle("metadata", () =>
    Effect.map(Threads, (threads) => ({
      name: threads.actorName ?? RESERVED_ACTOR,
      storage: { kind: "sqlite", location: threads.sqlite }
    }))))

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

// layerMethodsGroup invokes and reads the method declarations carried by the mounted actor runtime.
export const layerMethodsGroup = HttpApiBuilder.group(ServerApi, "methods", (handlers) =>
  handlers
    .handle("methods", () =>
      Effect.map(Threads, (threads) =>
        Object.entries(threads.methods).map(([name, method]) => ({
          name,
          cancellable: method.cancellation !== undefined,
          timeoutMs: method.timeoutMs,
          inputSchema: jsonSchemaOf(method.input),
          outputSchema: jsonSchemaOf(method.output)
        }))))
    .handle("invoke", ({ params, query, payload }) =>
      Effect.gen(function*() {
        const service = yield* Threads
        const threads = yield* service.ensure(params.id)
        const method = yield* methodOf(threads, params.method)
        const existing = (yield* threads.events(params.thread))
          .map(actorInvocationContextFrom)
          .find((context) => context?.invocation.method === params.method &&
            context.invocation.id === params.call && context.invocation.epoch === 0 && context.deadlineAt !== undefined)
        if (existing?.deadlineAt !== undefined) {
          return {
            actor: params.id,
            thread: params.thread,
            method: params.method,
            call: params.call,
            deadlineAt: existing.deadlineAt
          }
        }
        const timeoutMs = yield* Effect.try({
          try: () => actorMethodTimeoutOf(query.timeoutMs),
          catch: (failure) => InvalidRequest.of(failureMessage(failure))
        })
        if (timeoutMs > method.timeoutMs) {
          return yield* Effect.fail(InvalidRequest.of(
            `timeoutMs cannot exceed method ${JSON.stringify(params.method)}'s declared ${method.timeoutMs}ms.`
          ))
        }
        const at = yield* Clock.currentTimeMillis
        const deadlineAt = at + timeoutMs
        if (!Number.isSafeInteger(deadlineAt)) {
          return yield* Effect.fail(InvalidRequest.of("timeoutMs produces a deadline outside the safe integer range."))
        }
        const context = {
          invocation: { method: params.method, id: params.call, epoch: 0 },
          deadlineAt
        }
        const event = yield* Effect.try({
          try: () => invokedEventOf(context, method.eventOf({ ...context, input: payload, at })),
          catch: (failure) => InvalidRequest.of(
            `The input for method ${JSON.stringify(params.method)} is invalid. ${failureMessage(failure)}`
          )
        })
        yield* threads.append(params.thread, event)
        return {
          actor: params.id,
          thread: params.thread,
          method: params.method,
          call: params.call,
          deadlineAt
        }
      }))
    .handle("methodState", ({ params }) =>
      Effect.gen(function*() {
        const threads = yield* actorOf(yield* Threads, params.id)
        const method = yield* methodOf(threads, params.method)
        const log = yield* logOf(threads.events, params.thread)
        const invocation = { method: params.method, id: params.call, epoch: method.currentEpoch(log, params.call) }
        const state = method.state(log, invocation)
        if (state === undefined) {
          return yield* Effect.fail(
            UnknownMethodCall.of(
              `No call named ${JSON.stringify(params.call)} exists for method ${JSON.stringify(params.method)} on this thread.`
            )
          )
        }
        return state
      }))
    .handle("cancel", ({ params, payload }) =>
      Effect.gen(function*() {
        const service = yield* Threads
        const threads = yield* actorOf(service, params.id)
        const method = yield* methodOf(threads, params.method)
        const log = yield* logOf(threads.events, params.thread)
        const invocation = { method: params.method, id: params.call, epoch: method.currentEpoch(log, params.call) }
        if (method.state(log, invocation) === undefined) {
          return yield* Effect.fail(UnknownMethodCall.of(
            `No call named ${JSON.stringify(params.call)} exists for method ${JSON.stringify(params.method)} on this thread.`
          ))
        }
        if (method.cancellation === undefined) {
          return yield* Effect.fail(InvalidRequest.of(
            `Method ${JSON.stringify(params.method)} does not declare cancellation.`
          ))
        }
        const disposition = cancellationDispositionOf(log, method, invocation)
        if (disposition === undefined) {
          return yield* Effect.fail(UnknownMethodCall.of(
            `No call named ${JSON.stringify(params.call)} exists for method ${JSON.stringify(params.method)} on this thread.`
          ))
        }
        if (disposition === "settled") {
          return yield* Effect.fail(InvocationSettled.of(
            `Invocation ${JSON.stringify(params.call)} has settled and cannot be cancelled.`
          ))
        }
        if (disposition !== "requestable") {
          return {
            actor: params.id,
            thread: params.thread,
            method: params.method,
            call: params.call,
            status: disposition
          }
        }
        const at = yield* Clock.currentTimeMillis
        yield* threads.append(params.thread, cancellationRequested({
          request: cancellationRequestIdOf(invocation),
          invocation,
          cause: "requested",
          ...(payload.reason === undefined ? {} : { reason: payload.reason }),
          at
        }))
        return {
          actor: params.id,
          thread: params.thread,
          method: params.method,
          call: params.call,
          status: "requested" as const
        }
      })))

// layerProjectionsGroup implements every declared projection the same way, because there is only
// one way: read the thread's log, hand it to `run` with the decoded query, and answer what comes
// back. Nothing about a projection's meaning reaches this module; the actor holds all of it.
// readOf is the whole of what serving a projection is: refuse an actor this build does not serve,
// read the thread's log, and hand it to `run` with the decoded query. Nothing about what a
// projection means reaches this module; the actor holds all of it (actor.ts, agentProjections).
const readOf = (declaration: ProjectionDeclaration) =>
(request: {
  readonly params: { readonly id: string; readonly thread: string }
  readonly query: never
}) =>
  Effect.gen(function*() {
    const threads = yield* actorOf(yield* Threads, request.params.id)
    const log = yield* logOf(threads.events, request.params.thread)
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
  "/v1/actors/:id/threads/:thread/projections/:name",
  Effect.gen(function*() {
    const params = yield* HttpRouter.params
    const name = paramOf(params, "name")
    return problemResponse(
      UnknownProjection.of(`No projection named ${JSON.stringify(name)} is mounted here. ${declaredDetail}`)
    )
  })
)

export const layerDefinitionsGroup = HttpApiBuilder.group(ServerApi, "definitions", (handlers) =>
  handlers
    .handle("definitions", () =>
      Effect.flatMap(Threads, (threads): Effect.Effect<ReadonlyArray<ActorSummary>> =>
        threads.definitions ?? Effect.succeed([{ name: RESERVED_ACTOR, builtIn: true }])))
    .handle("pushDefinition", ({ payload }) =>
      Effect.gen(function*() {
        const threads = yield* Threads
        if (threads.pushDefinition === undefined) {
          return yield* Effect.fail(InvalidRequest.of("This server does not accept actor pushes."))
        }
        return yield* Effect.mapError(threads.pushDefinition(payload), (error) => InvalidRequest.of(error.message))
      })))

export const layerActorsGroup = HttpApiBuilder.group(ServerApi, "actors", (handlers) =>
  handlers
    .handle("actors", () => Effect.flatMap(Threads, (threads) => threads.instances))
    .handle("ensureActor", ({ params }) =>
      Effect.gen(function*() {
        const threads = yield* Threads
        yield* threads.ensure(params.id)
        return { id: params.id, definition: threads.actorName ?? RESERVED_ACTOR }
      }))
    .handle("actor", ({ params }) =>
      Effect.gen(function*() {
        const threads = yield* Threads
        yield* actorOf(threads, params.id)
        return { id: params.id, definition: threads.actorName ?? RESERVED_ACTOR }
      })))

const catalogSnapshot = Effect.flatMap(ModelCatalogStore, (catalog) =>
  catalog.snapshot === undefined
    ? Effect.fail(ModelCatalogUnavailable.of(
      "No validated model catalog is available. Check the server startup logs and catalog configuration."
    ))
    : Effect.succeed(catalog.snapshot))

const catalogDiscovery = Effect.all([catalogSnapshot, ServerConfig]).pipe(
  Effect.map(([catalog, config]) => ({
    catalog,
    availability: providerAvailabilitiesOf(config.model, config.modelCredentials),
    policy: { ...(config.model.default === undefined ? {} : { default: config.model.default }), allow: config.model.allow }
  }))
)

// layerModelsGroup pages the process snapshot using provider readiness derived without credential values.
export const layerModelsGroup = HttpApiBuilder.group(ServerApi, "models", (handlers) =>
  handlers
    .handle("providers", ({ query }) => Effect.flatMap(catalogDiscovery, ({ catalog, availability, policy }) =>
      Effect.try({
        try: () => providersPageOf(catalog, availability, { ...query, policy }),
        catch: (error) => InvalidRequest.of(failureMessage(error))
      })))
    .handle("models", ({ query }) => Effect.flatMap(catalogDiscovery, ({ catalog, availability, policy }) =>
      Effect.try({
        try: () => modelsPageOf(catalog, availability, { ...query, policy }),
        catch: (error) => InvalidRequest.of(failureMessage(error))
      }))))
