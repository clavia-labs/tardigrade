import type { Event } from "@clavia/tardigrade-core/log/event"
import { boundaryOf } from "@clavia/tardigrade-agent/output/boundary"
import { turnEpochOf } from "@clavia/tardigrade-code/execution/turns"
import { Effect, type Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { HttpApiClient, type HttpApi } from "effect/unstable/httpapi"
import type { InvocationCoordinate } from "@clavia/tardigrade-core/interaction"
import type { ThreadCoordinate } from "@clavia/tardigrade-core/actor/coordinate"
import { httpCallOf } from "./invocation-compat"
import type {
  ActorMethodCancellation,
  ActorMethodInput,
  ActorMethodOutput,
  ActorMethods
} from "@clavia/tardigrade-core/actor/method"
import type { ActorMethodState } from "@clavia/tardigrade-core/interaction/state"

import {
  actorApiOf,
  controlApi,
  ResumeRefused,
  type Accepted,
  type ActorArtifact,
  type ActorInstanceSummary,
  type ActorMetadata,
  type ActorSummary,
  type Append,
  type CatalogAvailabilityFilter,
  type CancellationResult,
  type ThreadNode,
  type ThreadSummary,
  type TreeBounds,
  type EventRow,
  type FactsRequest,
  type Health,
  MethodState,
  type MethodAccepted,
  type MethodSummary,
  type ModelCatalogPage,
  type ModelCatalogPriceSort,
  type ModelCatalogSortOrder,
  type ModelCatalogUnpricedOrder,
  type ProviderCatalogPage,
  type Projections
} from "./contract"
import { isProblem, NO_ANSWER, problemOf, ProblemError } from "./problem"
import { actorThreadsStream, inferenceStream, stream, type ActorThreadsStreamOptions, type InferenceStreamOptions, type OpenEventSource, type StreamOptions } from "./stream"

// The client, derived from the declaration. Every method here is one endpoint of contract.ts read
// through HttpApiClient, so a route this client can call is a route the server declared, and the
// wire types are the declaration's own rather than a copy (client.test.ts).
//
// The methods answer with promises. The declaration's Effects are the shape a caller composes with;
// a promise is the shape a screen consumes, and the failure a promise rejects with is always a
// ProblemError, so a consumer parses one error shape (problem.ts).

// Where the server listens when a caller states no base URL, matching the server's own DEFAULT_PORT
// (apps/server/src/config.ts).
export const DEFAULT_BASE_URL = "http://localhost:4242"
export const DEFAULT_ACTOR_INSTANCE = "main"

// The titles a failure that carries no problem document shows. They stand where the server's own
// `title` would be, so a screen renders one field either way.
export const UNREACHABLE_TITLE = "Server Unreachable"

export const UNEXPECTED_RESPONSE_TITLE = "Unexpected Response"

export const SERVER_ERROR_TITLE = "Server Error"

export const SERVER_ERROR_DETAIL =
  "The server could not read this actor. Check the actor host logs. For `tdg dev`, confirm that the project directory and `.tardigrade/actor.sqlite` still exist, then restart it."

export const UNREADABLE_EXCHANGE_TITLE = "Unreadable Exchange"

// One derived projection call, as much of its shape as the lookup below needs. The declaration's
// own types are what a caller sees (ActorClient.projection); this is the untyped middle.
// The client HttpApiClient derives for one actor's API: the log's methods, the actor's projections
// keyed by name, and the health probe.
type GroupsOf<Api> = Api extends HttpApi.HttpApi<string, infer Groups> ? Groups : never

type DerivedActorApi<P extends Projections> = HttpApiClient.Client<GroupsOf<ReturnType<typeof actorApiOf<P>>>>

type DerivedControlApi = HttpApiClient.Client<GroupsOf<typeof controlApi>>

type ProjectionCall = (request: {
  readonly params: { readonly id: string; readonly thread: string }
  readonly query: unknown
}) => Effect.Effect<unknown, unknown>

export interface ActorClientOptions<P extends Projections = {}, M extends ActorMethods = ActorMethods> {
  // The server's address. A path on it is kept, so a server mounted under a prefix works.
  readonly baseUrl?: string | undefined
  // The bearer token, sent as an `authorization` header on every request (apps/server/src/http.ts,
  // layerAuth). The tail cannot carry it (stream.ts).
  readonly token?: string | undefined
  // How the tail opens a connection. The default is `globalThis.EventSource`.
  readonly eventSource?: OpenEventSource | undefined
  // How a request reaches the network. The default is the platform's own fetch, read through
  // FetchHttpClient's reference. A caller states this to route requests somewhere else: a test
  // stub, a proxy, or a runtime whose fetch is not the global one. Patching `globalThis.fetch`
  // does not work, because the reference resolves its default once per process
  // (client.test.ts, "sends every request through the stated fetch").
  readonly fetch?: typeof globalThis.fetch | undefined
  // The projections the actor this client addresses declares. The platform's API is the log, so a
  // client that reads the log alone states none; one that calls a projection states the same
  // declaration the server mounts (contract.ts, apiOf).
  readonly projections?: P | undefined
  // methods preserves the mounted actor's call types at this client boundary.
  readonly methods?: M | undefined
}

export interface EventsOptions {
  // The seq to read past. The server numbers events from 1, so `after: 40` starts at 41.
  readonly after?: number | undefined
  readonly limit?: number | undefined
  // Event type names, sent as one comma-joined `types` param.
  readonly types?: ReadonlyArray<string> | undefined
}


export interface CatalogPageOptions {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
  readonly search?: string | undefined
  readonly availability?: CatalogAvailabilityFilter | undefined
}

export interface ModelPageOptions extends CatalogPageOptions {
  readonly provider?: string | undefined
  readonly sort?: ModelCatalogPriceSort | undefined
  readonly order?: ModelCatalogSortOrder | undefined
  readonly unpriced?: ModelCatalogUnpricedOrder | undefined
}

// What a caller states to follow a log: the tail's options, less the ones the client already holds.
export type FollowOptions = Omit<StreamOptions, "baseUrl" | "actor" | "thread" | "eventSource">

export type FollowThreadsOptions = Omit<ActorThreadsStreamOptions, "baseUrl" | "actor" | "eventSource">

export type FollowInferenceOptions = Omit<InferenceStreamOptions, "baseUrl" | "actor" | "thread" | "eventSource">

// The query one projection accepts, and what it answers: both read from the actor's own
// declaration, so a caller states what that projection states and gets back what it promises
// (contract.ts, projection).
export type ProjectionQuery<P extends Projections, Name extends keyof P> = SchemaStructType<P[Name]["params"]>

export type ProjectionResult<P extends Projections, Name extends keyof P> = P[Name]["result"]["Type"]

// MethodCall carries the caller-minted id and the selected declaration's input type.
export type MethodCall<M extends ActorMethods, Name extends keyof M> = {
  readonly id: string
  readonly input: ActorMethodInput<M[Name]>
  readonly timeoutMs?: number
}

// ActorCallRef addresses one logical method call across its control and state operations.
export interface ActorCallRef<Name extends string = string> {
  readonly reference?: InvocationCoordinate
  readonly actor: string
  readonly thread: string
  readonly method: Name
  readonly id: string
}

// ActorCallHandle carries the durable deadline returned when a logical call is accepted.
export type ActorCallHandle<Name extends string = string> = ActorCallRef<Name> &
  Omit<MethodAccepted, "actor" | "thread" | "method" | "call">

export interface CancellationOptions {
  readonly reason?: string
}

type DeclaredCancellableMethod<M extends ActorMethods> = {
  [Name in keyof M & string]: M[Name] extends { readonly cancellation: ActorMethodCancellation } ? Name : never
}[keyof M & string]

export type CancellableMethod<M extends ActorMethods> = string extends keyof M
  ? string
  : DeclaredCancellableMethod<M>

type SchemaStructType<Fields> = Fields extends Schema.Struct.Fields ? Schema.Struct<Fields>["Type"] : never

export interface ActorClient<P extends Projections = {}, M extends ActorMethods = ActorMethods> {
  readonly baseUrl: string
  // metadata describes the actor mounted behind this runtime origin.
  readonly metadata: () => Promise<ActorMetadata>
  // providers reads setup requirements from the validated public catalog.
  readonly providers: (options?: CatalogPageOptions) => Promise<ProviderCatalogPage>
  // models searches the validated public catalog.
  readonly models: (options?: ModelPageOptions) => Promise<ModelCatalogPage>
  readonly actors: () => Promise<ReadonlyArray<ActorInstanceSummary>>
  readonly ensureActor: (actor: string) => Promise<ActorInstanceSummary>
  readonly actor: (actor: string) => Promise<ActorInstanceSummary>
  // list reads the actor's roster, bounded by `options` when stated (contract.ts, TreeBounds).
  readonly list: (actor: string, options?: TreeBounds) => Promise<ReadonlyArray<ThreadSummary>>
  // tree reads one thread's spawn family beneath it, bounded by `options` when stated (contract.ts, TreeBounds).
  readonly tree: (actor: string, thread: string, options?: Omit<TreeBounds, "root">) => Promise<ThreadNode>
  readonly events: (actor: string, thread: string, options?: EventsOptions) => Promise<ReadonlyArray<EventRow>>
  readonly facts: (actor: string, thread: string, request: FactsRequest) => Promise<ReadonlyArray<EventRow>>
  // Appends one event to a thread's log. A brief is `{ type: "MessageReceived", id, text }`; the
  // platform requires nothing but `type` (contract.ts, Append).
  readonly append: (actor: string, thread: string, event: Append) => Promise<Accepted>
  readonly allocateRoot: (actor: string, name?: string) => Promise<ThreadCoordinate>
  // methods lists the mounted actor's callable interface and JSON Schema documents.
  readonly methods: () => Promise<ReadonlyArray<MethodSummary>>
  // call commits one declared method call and returns its durable handle.
  readonly call: <const Name extends keyof M & string>(
    actor: string,
    thread: string,
    name: Name,
    call: MethodCall<M, Name>
  ) => Promise<ActorCallHandle<Name>>
  // state reads one logical call's typed durable state.
  readonly state: <const Name extends keyof M & string>(
    call: ActorCallRef<Name> | InvocationCoordinate
  ) => Promise<ActorMethodState<ActorMethodOutput<M[Name]>>>
  // methodState preserves the positional state lookup for existing callers.
  readonly methodState: <const Name extends keyof M & string>(
    actor: string,
    thread: string,
    name: Name,
    call: string
  ) => Promise<ActorMethodState<ActorMethodOutput<M[Name]>>>
  // cancel ensures the singleton cancellation resource for a cancellable logical call.
  readonly cancel: <const Name extends CancellableMethod<M>>(
    call: ActorCallRef<Name> | InvocationCoordinate,
    options?: CancellationOptions
  ) => Promise<CancellationResult>
  // Resumes a failed turn by appending the TurnResumed its reactors already interpret. It is the
  // SDK's convenience rather than a route: the platform has no resume, because a resume is an
  // append like any other (resume, below).
  readonly resume: (actor: string, thread: string, turn: string) => Promise<Accepted>
  readonly health: () => Promise<Health>
  // Reads one projection the actor declared. The name is one this client was built with, and the
  // query and the answer are that declaration's own types (client.test.ts, "a declared projection
  // serves and types").
  readonly projection: <const Name extends keyof P & string>(
    actor: string,
    thread: string,
    name: Name,
    query?: ProjectionQuery<P, Name>
  ) => Promise<ProjectionResult<P, Name>>
  // Follows one thread's log and answers with the unsubscribe.
  readonly follow: (actor: string, thread: string, options: FollowOptions) => (() => void)
  readonly followThreads: (actor: string, options: FollowThreadsOptions) => (() => void)
  readonly followInference: (actor: string, thread: string, options: FollowInferenceOptions) => (() => void)
}

export interface ControlClient {
  readonly baseUrl: string
  readonly definitions: () => Promise<ReadonlyArray<ActorSummary>>
  readonly pushDefinition: (artifact: ActorArtifact) => Promise<ActorSummary>
}

export type ControlClientOptions = Pick<ActorClientOptions, "baseUrl" | "token" | "fetch">

const messageOf = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure)

// problemErrorOf turns whatever a call failed with into the one error shape a caller handles. A
// declared failure is already the document. A status the declaration does not name still carries
// one, because every route this server answers writes problem+json (apps/server/src/http.ts,
// layerAuth), so the body is read before the status line is fallen back on.
const problemErrorOf = (failure: unknown): Effect.Effect<ProblemError> => {
  if (failure instanceof ProblemError) return Effect.succeed(failure)
  if (isProblem(failure)) return Effect.succeed(problemOf(failure.status, failure, failure.title))
  if (failure instanceof HttpClientError.HttpClientError) {
    const response = failure.response
    if (response === undefined) {
      return Effect.succeed(
        new ProblemError({ title: UNREACHABLE_TITLE, status: NO_ANSWER, detail: messageOf(failure) })
      )
    }
    return Effect.map(
      Effect.orElseSucceed(response.json, () => undefined),
      (body) =>
        isProblem(body)
          ? problemOf(response.status, body, UNEXPECTED_RESPONSE_TITLE)
          : response.status >= 500
          ? new ProblemError({
            title: SERVER_ERROR_TITLE,
            status: response.status,
            detail: SERVER_ERROR_DETAIL
          })
          : new ProblemError({
            title: UNEXPECTED_RESPONSE_TITLE,
            status: response.status,
            detail: messageOf(failure)
          })
    )
  }
  return Effect.succeed(
    new ProblemError({ title: UNREADABLE_EXCHANGE_TITLE, status: NO_ANSWER, detail: messageOf(failure) })
  )
}

const run = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> => {
  try { return await Effect.runPromise(Effect.catch(effect, (failure) => Effect.flatMap(problemErrorOf(failure), Effect.fail)), signal === undefined ? {} : { signal }) }
  catch (error) { signal?.throwIfAborted(); throw error }
}

const transportOf = (options: ControlClientOptions): HttpClient.HttpClient => {
  const transport = Effect.runSync(HttpClient.HttpClient.pipe(
    Effect.provide(FetchHttpClient.layer),
    options.fetch === undefined ? (self) => self : Effect.provideService(FetchHttpClient.Fetch, options.fetch)
  ))
  return options.token === undefined ? transport : HttpClient.mapRequest(transport, HttpClientRequest.bearerToken(options.token))
}

// actorHttpClient shares endpoint codecs, transport configuration, and errors between client facades.
export const actorHttpClient = <P extends Projections = {}>(options: ActorClientOptions<P> = {}) => {
  const httpClient = transportOf(options)
  const derived = HttpApiClient.makeWith(actorApiOf(options.projections ?? ({} as P)), { httpClient, baseUrl: options.baseUrl ?? DEFAULT_BASE_URL })
  // derived has no requirements for concrete projection declarations.
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
  const api = Effect.runSync(derived as Effect.Effect<DerivedActorApi<P>>)
  return {
    api, run,
    stateAt: (url: string, signal?: AbortSignal) => run(httpClient.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.flatMap(HttpClientResponse.schemaBodyJson(MethodState))
    ), signal)
  }
}

// The query the declaration accepts, with the fields a caller left out left out. A key carrying
// `undefined` is not the same as an absent key to an optional Schema, so the object is built rather
// than spread (contract.ts, SeqQuery).
const eventsQuery = (options: EventsOptions) => {
  const query: { after?: number; limit?: number; types?: string } = {}
  if (options.after !== undefined) query.after = options.after
  if (options.limit !== undefined) query.limit = options.limit
  if (options.types !== undefined && options.types.length > 0) query.types = options.types.join(",")
  return query
}

// boundsQuery omits absent query parameters (client.test.ts).
const boundsQuery = (options: TreeBounds) => {
  const query: { root?: string; maxDepth?: number; maxNodes?: number } = {}
  if (options.root !== undefined) query.root = options.root
  if (options.maxDepth !== undefined) query.maxDepth = options.maxDepth
  if (options.maxNodes !== undefined) query.maxNodes = options.maxNodes
  return query
}

const catalogQuery = (options: ModelPageOptions) => {
  const query: { availability?: CatalogAvailabilityFilter; cursor?: string; limit?: number; provider?: string; search?: string; sort?: ModelCatalogPriceSort; order?: ModelCatalogSortOrder; unpriced?: ModelCatalogUnpricedOrder } = {}
  if (options.availability !== undefined) query.availability = options.availability
  if (options.cursor !== undefined) query.cursor = options.cursor
  if (options.limit !== undefined) query.limit = options.limit
  if (options.provider !== undefined) query.provider = options.provider
  if (options.search !== undefined) query.search = options.search
  if (options.sort !== undefined) query.sort = options.sort
  if (options.order !== undefined) query.order = options.order
  if (options.unpriced !== undefined) query.unpriced = options.unpriced
  return query
}

// makeActorClient builds the client once. The derivation reads the declaration and compiles an encoder
// and a decoder per endpoint, so it happens at construction rather than per call.
export const makeActorClient = <const P extends Projections = {}, const M extends ActorMethods = ActorMethods>(
  options: ActorClientOptions<P, M> = {}
): ActorClient<P, M> => {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const { api } = actorHttpClient(options)
  const append = (actor: string, thread: string, event: Append): Promise<Accepted> =>
    run(api.threads.append({ params: { id: actor, thread }, payload: event }))
  const invocationState = (call: ActorCallRef | InvocationCoordinate) => {
    const handle = httpCallOf(call)
    return run(api.methods.methodState({
      params: {
        id: handle.actor,
        thread: handle.thread,
        method: handle.method,
        call: handle.id
      },
      query: handle.epoch === undefined ? {} : { epoch: handle.epoch, actor: handle.definition }
    }))
  }

  // logOf follows server-sized pages until exhaustion (client.test.ts, "resume follows every event page").
  const logOf = async (actor: string, thread: string): Promise<ReadonlyArray<Event>> => {
    const log: Event[] = []
    let after = 0
    for (;;) {
      const page = await run(api.threads.events({ params: { id: actor, thread }, query: { after } }))
      if (page.length === 0) return log
      const next = page[page.length - 1]!.seq
      if (next <= after) throw new ProblemError({ title: UNREADABLE_EXCHANGE_TITLE, status: NO_ANSWER, detail: "Event page did not advance its cursor." })
      log.push(...page.map((row) => row.event))
      after = next
    }
  }

  return {
    baseUrl,
    metadata: () => run(api.runtime.metadata({})),
    providers: (options = {}) => run(api.models.providers({ query: catalogQuery(options) })),
    models: (options = {}) => run(api.models.models({ query: catalogQuery(options) })),
    actors: () => run(api.actors.actors({})),
    ensureActor: (actor) => run(api.actors.ensureActor({ params: { id: actor } })),
    actor: (actor) => run(api.actors.actor({ params: { id: actor } })),
    list: (actor, options) => run(api.threads.list({ params: { id: actor }, query: boundsQuery(options ?? {}) })),
    tree: (actor, thread, options) =>
      run(api.threads.tree({ params: { id: actor, thread }, query: boundsQuery(options ?? {}) })),
    events: (actor, thread, events = {}) =>
      run(api.threads.events({ params: { id: actor, thread }, query: eventsQuery(events) })),
    facts: (actor, thread, request) =>
      run(api.threads.facts({ params: { id: actor, thread }, payload: request })),
    append,
    allocateRoot: (actor, name) => run(api.threads.allocateRoot({ query: {}, params: { id: actor }, payload: name === undefined ? {} : { name } })),
    methods: () => run(api.methods.methods({})),
    call: async (actor, thread, name, call) => {
      const accepted = await run(api.methods.invokeMethod({
        params: { id: actor, thread, method: name },
        headers: { "idempotency-key": call.id },
        query: call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs },
        payload: call.input
      }))
      return {
        reference: accepted.reference,
        actor: accepted.reference.target.instance,
        thread: accepted.reference.target.thread,
        method: name,
        id: accepted.call,
        deadlineAt: accepted.deadlineAt
      } as never
    },
    state: (invocation) => invocationState(invocation) as never,
    methodState: (actor, thread, name, call) =>
      run(api.methods.methodState({
        params: { id: actor, thread, method: name, call },
        query: {}
      })) as never,
    cancel: (reference, cancellation = {}) => {
      const call = httpCallOf(reference)
      return run(api.methods.cancel({
        params: {
          id: call.actor,
          thread: call.thread,
          method: call.method,
          call: call.id
        },
        query: call.epoch === undefined ? {} : { epoch: call.epoch, actor: call.definition },
        payload: cancellation.reason === undefined ? {} : { reason: cancellation.reason }
      }))
    },
    // A resume is an append, so the platform has no route for it and no guard over it. The check
    // below is advisory: it reads the event log to refuse the obvious mistake early and to
    // learn the epoch to stamp. A turn that fails between the read and the append still gets a
    // TurnResumed, and a TurnResumed for a turn that is not failed derives nothing, so a race costs
    // an inert event rather than a wrong outcome. A duplicate costs nothing either: the assembly
    // keys TurnResumed by turn and epoch, so a second one absorbs (packages/agent/src/log/events.ts,
    // agentKeys).
    resume: async (actor, thread, turn) => {
      const log = await logOf(actor, thread)
      if (!log.some((event) => event.type === "MessageReceived" && String((event as { id?: unknown }).id ?? "") === turn)) {
        throw new ProblemError({
          ...ResumeRefused.of(`No turn named ${JSON.stringify(turn)} has been served on this thread.`)
        })
      }
      const boundary = boundaryOf(log, turn)
      const status = boundary?.kind === "requesting" ? "parked" : boundary?.kind ?? "pending"
      if (status !== "failed") {
        throw new ProblemError({
          ...ResumeRefused.of(
            `turn ${JSON.stringify(turn)} cannot resume because its active epoch is ${status}`
          )
        })
      }
      // The next execution epoch, stamped the way the library stamps it
      // (packages/agent/src/runtime/resume.ts, resumeTurn).
      const epoch = turnEpochOf(log, turn)
      return append(actor, thread, {
        type: "TurnResumed",
        turn,
        failedEpoch: epoch,
        epoch: epoch + 1
      })
    },
    health: () => run(api.health.healthz({})),
    // The derivation keys the projections group by name, and the name a caller passes is one of
    // those keys, so the lookup cannot miss. The types are recovered on the way out because an
    // index into a mapped record of endpoint methods is not one the compiler can narrow per call.
    projection: (actor, thread, name, query) =>
      // ProjectionCall erases the selected endpoint failure before run converts it to ProblemError.
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      run((api.projections as Record<string, ProjectionCall>)[name]!({
        params: { id: actor, thread },
        query: query ?? {}
      })) as never,
    follow: (actor, thread, follow) =>
      stream({
        ...follow,
        baseUrl,
        actor,
        thread,
        ...(options.eventSource === undefined ? {} : { eventSource: options.eventSource })
      }),
    followThreads: (actor, follow) =>
      actorThreadsStream({
        ...follow,
        baseUrl,
        actor,
        ...(options.eventSource === undefined ? {} : { eventSource: options.eventSource })
      }),
    followInference: (actor, thread, follow) =>
      inferenceStream({
        ...follow,
        baseUrl,
        actor,
        thread,
        ...(options.eventSource === undefined ? {} : { eventSource: options.eventSource })
      })
  }
}

// makeControlClient builds the client for actor deployment and discovery at a hosting origin.
export const makeControlClient = (options: ControlClientOptions = {}): ControlClient => {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const api = Effect.runSync(HttpApiClient.makeWith(controlApi, { baseUrl, httpClient: transportOf(options) }) as Effect.Effect<DerivedControlApi>)
  return {
    baseUrl,
    definitions: () => run(api.definitions.definitions({})),
    pushDefinition: (artifact) => run(api.definitions.pushDefinition({ payload: artifact }))
  }
}
