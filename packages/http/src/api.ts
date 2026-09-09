import { Context, Duration, Effect, Layer, Stream, type Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, type HttpApiEndpoint } from "effect/unstable/httpapi"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ThreadEventRow } from "@clavia/tardigrade-core/log"
import type { ActorThreadRecord } from "@clavia/tardigrade-core/actor"

import {
  Api,
  apiOf,
  InvalidRequest,
  invalidRequest,
  RESERVED_ACTOR,
  unacceptableField,
  UnknownActor,
  UnknownProjection,
  UnknownThread,
  type ActorSummary,
  type ActorThread,
  type ThreadAdded,
  type ThreadsSnapshot,
  type ProjectionDeclaration,
  type ThreadNode
} from "@clavia/tardigrade-client/contract"
import { methodHandlers } from "./methods"
import { catalogHandlers, type CatalogDiscovery } from "./models"
import { Threads, type ActorThreads } from "./threads"
import { publicThreadId, resolveThreadId } from "./thread-compat"
import type { InferenceStream } from "./inference-stream"
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

// DEFAULT_INFERENCE_STREAM_BUFFER_CAPACITY bounds unread transient frames per browser connection.
export const DEFAULT_INFERENCE_STREAM_BUFFER_CAPACITY = 64

export type HttpProjections = Record<string, {
  readonly run: ProjectionDeclaration["run"]
  readonly params: Readonly<Record<string, Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>>
  readonly result: Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }
}>

export interface ApiOptions {
  readonly token?: string | undefined
  readonly catalog?: typeof CatalogDiscovery.Service
  readonly projections?: HttpProjections
  readonly limit?: number
  readonly heartbeat?: Duration.Input
  readonly inference?: InferenceStream
  readonly inferenceBufferCapacity?: number
  readonly streamShutdownSignal?: AbortSignal
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

const logsOf = (entries: ReadonlyArray<{ readonly id: string; readonly events: ReadonlyArray<Event> }>) =>
  new Map(entries.map((entry) => [entry.id, entry.events] as const))

const frameOf = (seq: number, event: unknown): string => `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`

// A comment frame: the client's parser drops it and the bytes keep the connection alive.
const HEARTBEAT = ": tardigrade\n\n"

const actorThreadOf = (record: ActorThreadRecord): ActorThread => ({
  id: publicThreadId(record.thread),
  ...(record.parentThread === undefined
    ? {}
    : { parent: publicThreadId(record.parentThread) }),
  depth: record.depth
})

// openTails counts the SSE tails this process holds. A tail is a fiber that outlives its request
// handler, so the count is what proves a disconnected client leaves nothing polling behind
// (api.test.ts, "a reconnect replays from Last-Event-ID and then runs live, once each": the tail is
// one while the client reads and zero once it aborts).
let openTails = 0

export const openStreams = (): number => openTails

interface TailOptions {
  readonly from: number
  readonly limit: number
  readonly heartbeat: Duration.Input
  readonly initial?: Effect.Effect<readonly [string, number]>
  readonly readPage: (cursor: number, limit: number) => Effect.Effect<ReadonlyArray<ThreadEventRow>>
  readonly awaitHead: (cursor: number) => Effect.Effect<number>
  readonly encodePage: (page: ReadonlyArray<ThreadEventRow>) => Effect.Effect<string>
}

const waitForHead = (
  awaitHead: TailOptions["awaitHead"],
  cursor: number,
  heartbeat: Duration.Input
) => Effect.race(
  Effect.map(awaitHead(cursor), (target) => ({ kind: "commit" as const, target })),
  Effect.as(Effect.sleep(heartbeat), { kind: "heartbeat" as const })
)

// resumableTail replays committed pages, waits at the head, and keeps an idle connection open.
const resumableTail = (options: TailOptions): Stream.Stream<Uint8Array> => {
  interface State {
    readonly cursor: number
    readonly waiting: boolean
  }
  const step = (state: State): Effect.Effect<readonly [string, State]> =>
    Effect.gen(function*() {
      let current = state
      let target: number | undefined
      for (;;) {
        if (current.waiting) {
          const wake = yield* waitForHead(options.awaitHead, current.cursor, options.heartbeat)
          if (wake.kind === "heartbeat") return [HEARTBEAT, current] as const
          target = wake.target
          current = { ...current, waiting: false }
        }
        const page = yield* options.readPage(current.cursor, options.limit)
        if (page.length > 0) {
          const frames = yield* options.encodePage(page)
          const cursor = page[page.length - 1]!.seq
          return [frames === "" ? HEARTBEAT : frames, {
            cursor,
            waiting: target !== undefined && cursor >= target
          }] as const
        }
        const wake = yield* waitForHead(options.awaitHead, current.cursor, options.heartbeat)
        if (wake.kind === "heartbeat") return [HEARTBEAT, { ...current, waiting: true }] as const
        target = wake.target
      }
    })
  const framesFrom = (cursor: number) => Stream.unfold({ cursor, waiting: false } as State, step)
  const frames = options.initial === undefined
    ? framesFrom(options.from)
    : Stream.unwrap(Effect.map(options.initial, ([frame, cursor]) =>
      Stream.succeed(frame).pipe(Stream.concat(framesFrom(cursor)))))
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

const streamCursor = Effect.gen(function*() {
  const query = yield* HttpServerRequest.ParsedSearchParams
  const rawAfter = singleOf(query["after"])
  const after = integerOf(rawAfter)
  if (rawAfter !== undefined && after === undefined) {
    return { problem: problemResponse(invalidRequest("Query", [unacceptableField("after")])) } as const
  }
  const request = yield* HttpServerRequest.HttpServerRequest
  const rawLastEventId = request.headers["last-event-id"]
  const lastEventId = integerOf(rawLastEventId)
  if (rawLastEventId !== undefined && lastEventId === undefined) {
    return { problem: problemResponse(invalidRequest("Headers", [unacceptableField("last-event-id")])) } as const
  }
  return { from: lastEventId ?? after } as const
})

const streamResponseOf = (body: Stream.Stream<Uint8Array>, signal?: AbortSignal) => {
  const stream = signal === undefined ? body : body.pipe(
    Stream.interruptWhen(Effect.callback<void>((resume) => {
      const stop = () => resume(Effect.void)
      if (signal.aborted) stop()
      else signal.addEventListener("abort", stop, { once: true })
      return Effect.sync(() => signal.removeEventListener("abort", stop))
    }))
  )
  return Effect.succeed(HttpServerResponse.stream(stream, {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache" }
  }))
}

// tail streams one thread with its durable sequence as both the page cursor and SSE id.
const tail = (
  readPage: ActorThreads["eventsPage"],
  awaitHead: ActorThreads["awaitHead"],
  id: string,
  from: number,
  limit: number,
  heartbeat: Duration.Input
): Stream.Stream<Uint8Array> => resumableTail({
  from,
  limit,
  heartbeat,
  readPage: (cursor, pageLimit) => readPage(id, cursor, pageLimit),
  awaitHead: (cursor) => awaitHead(id, cursor),
  encodePage: (page) => Effect.succeed(page.map(({ seq, event }) => frameOf(seq, event)).join(""))
})

const actorThreadsTail = (
  threads: ActorThreads,
  from: number | undefined,
  limit: number,
  heartbeat: Duration.Input
): Stream.Stream<Uint8Array> => {
  const initial = from === undefined
    ? Effect.map(threads.actorThreads, ({ cursor, threads: records }) => [
      frameOf(cursor, {
        type: "ThreadsSnapshot",
        threads: records.filter((record) => record.state === "registered").map(actorThreadOf)
      } satisfies ThreadsSnapshot),
      cursor
    ] as const)
    : undefined
  return resumableTail({
    from: from ?? 0,
    limit,
    heartbeat,
    ...(initial === undefined ? {} : { initial }),
    readPage: threads.actorEventsPage,
    awaitHead: threads.awaitActorHead,
    encodePage: (page) => Effect.map(
      Effect.forEach(page, ({ seq, event }) => {
        if (event.type !== "ThreadRegistered" || typeof event.thread !== "string") return Effect.succeed("")
        return Effect.map(threads.actorThread(event.thread), (record) =>
          record === undefined
            ? ""
            : frameOf(seq, { type: "ThreadAdded", thread: actorThreadOf(record) } satisfies ThreadAdded))
      }),
      (frames) => frames.join("")
    )
  })
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
  heartbeat: Duration.Input,
  signal?: AbortSignal
) => Effect.gen(function*() {
  const first = yield* threads.eventsPage(id, 0, 1)
  if (first.length === 0) return problemResponse(UnknownThread.of(unknownThreadDetail(id)))
  const cursor = yield* streamCursor
  if (cursor.problem !== undefined) return cursor.problem
  return yield* streamResponseOf(tail(threads.eventsPage, threads.awaitHead, id, cursor.from ?? 0, limit, heartbeat), signal)
})

const actorThreadsStreamResponse = (
  threads: ActorThreads,
  limit: number,
  heartbeat: Duration.Input,
  signal?: AbortSignal
) => Effect.gen(function*() {
  const cursor = yield* streamCursor
  if (cursor.problem !== undefined) return cursor.problem
  return yield* streamResponseOf(actorThreadsTail(threads, cursor.from, limit, heartbeat), signal)
})

const inferenceStreamResponse = (
  inference: InferenceStream,
  actor: string,
  thread: string,
  heartbeat: Duration.Input,
  bufferCapacity: number,
  signal?: AbortSignal
) => Effect.sync(() => {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let stop: (() => void) | undefined
  const cleanup = () => {
    unsubscribe?.()
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    if (stop !== undefined) signal?.removeEventListener("abort", stop)
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stop = () => { cleanup(); controller.close() }
      if (signal?.aborted) { stop(); return }
      signal?.addEventListener("abort", stop, { once: true })
      unsubscribe = inference.subscribe((delta) => {
        if (delta.instance !== actor || delta.thread !== thread) return
        if ((controller.desiredSize ?? 1) <= 0) return
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta)}\n\n`))
      })
      heartbeatTimer = setInterval(() => {
        if ((controller.desiredSize ?? 1) > 0) controller.enqueue(encoder.encode(HEARTBEAT))
      }, Duration.toMillis(heartbeat))
    },
    cancel: cleanup
  }, { highWaterMark: bufferCapacity })
  return HttpServerResponse.raw(body, {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache" }
  })
})

export const layerStream = (options: ApiOptions = {}) => {
  const limit = options.limit ?? DEFAULT_EVENT_LIMIT
  const heartbeat = options.heartbeat ?? DEFAULT_SSE_HEARTBEAT
  const bufferCapacity = options.inferenceBufferCapacity ?? DEFAULT_INFERENCE_STREAM_BUFFER_CAPACITY
  if (!Number.isSafeInteger(bufferCapacity) || bufferCapacity <= 0) {
    throw new Error(`inference stream buffer capacity must be a positive integer, got ${bufferCapacity}`)
  }
  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/v1/actors/:id/threads/:thread/events/stream",
      Effect.gen(function*() {
        const params = yield* HttpRouter.params
        const service = yield* Threads
        const threads = yield* actorOf(service, paramOf(params, "id"))
        return yield* streamResponse(threads, paramOf(params, "thread"), limit, heartbeat, options.streamShutdownSignal)
      })
    ),
    HttpRouter.add(
      "GET",
      "/v1/actors/:id/threads/stream",
      Effect.gen(function*() {
        const params = yield* HttpRouter.params
        const threads = yield* (yield* Threads).ensure(paramOf(params, "id"))
        return yield* actorThreadsStreamResponse(threads, limit, heartbeat, options.streamShutdownSignal)
      })
    ),
    ...(options.inference === undefined ? [] : [HttpRouter.add(
      "GET",
      "/v1/actors/:id/threads/:thread/inference/stream",
      Effect.gen(function*() {
        const params = yield* HttpRouter.params
        const threads = yield* (yield* Threads).ensure(paramOf(params, "id"))
        const thread = yield* resolveThreadId(paramOf(params, "thread"), (thread) => Effect.map(threads.actorThread(thread), (record) => record !== undefined))
        return yield* inferenceStreamResponse(
          options.inference!,
          paramOf(params, "id"),
          thread,
          heartbeat,
          bufferCapacity,
          options.streamShutdownSignal
        )
      })
    )])
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
      .handle("allocateRoot", ({ params, payload, query }) => Effect.gen(function* () {
        const service = yield* Threads
        if (query.actor !== undefined && query.actor !== (service.actorName ?? RESERVED_ACTOR)) return yield* Effect.fail(InvalidRequest.of("Allocation target actor does not match this deployment."))
        const threads = yield* service.ensure(params.id)
        return yield* threads.allocateRoot(payload.name, payload)
      }))
      // The body is the declared payload, decoded before this runs: a body that is not one is
      // refused by the declaration and rendered as a problem document (contract.ts,
      // layerRequestProblems), so the handler only ever sees an event.
      .handle("append", ({ params, payload }) =>
        Effect.gen(function*() {
          const service = yield* Threads
          const threads = yield* actorOf(service, params.id)
          yield* logOf(threads.events, params.thread)
          yield* threads.append(params.thread, payload)
          return { actor: params.id, thread: params.thread }
        }))
      .handle("list", ({ params, query }) =>
        Effect.gen(function*() {
          const threads = yield* actorOf(yield* Threads, params.id)
          const tree = treeOf(logsOf(yield* threads.list), threads.statusOf, query)
          if (tree === undefined) {
            if (query.root === undefined) {
              return yield* Effect.die(new Error("a roster read without a root cannot be absent"))
            }
            return yield* Effect.fail(UnknownThread.of(unknownThreadDetail(query.root)))
          }
          return flatten(tree)
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
      .handle("tree", ({ params, query }) =>
        Effect.gen(function*() {
          const threads = yield* actorOf(yield* Threads, params.id)
          const tree = treeOf(logsOf(yield* threads.list), threads.statusOf, { ...query, root: params.thread })
          const node = tree?.[0]
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
      storage: threads.storage
    }))))

// ServerApi is the surface this process serves: the platform's log routes, actor methods, and declared projections.
export const ServerApi = Api

export const layerMethodsGroup = methodHandlers(Threads)

// readOf applies a custom projection to an existing thread log (http.test.ts, custom log projections).
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

export const layerProjectionsGroup = (projections: HttpProjections = {}) => HttpApiBuilder.group(apiOf(projections), "projections", (handlers) => {
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
    Object.entries(projections).map(([name, declaration]) => [name, readOf(declaration)])
  ) as unknown as Complete
  return handlers.handleAll(served)
})

// The name a request asked for when the actor never declared it.
export const layerUnknownProjection = (projections: HttpProjections = {}) => {
  const declaredProjections = Object.keys(projections)
  const declaredDetail = declaredProjections.length === 0
    ? "This actor declares no projections."
    : `This actor declares ${declaredProjections.map((name) => JSON.stringify(name)).join(", ")}.`

  return HttpRouter.add(
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

}

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

export const layerModelsGroup = (options: ApiOptions = {}) => catalogHandlers(Effect.succeed(options.catalog))
