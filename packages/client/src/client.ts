import { Effect, type Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient, type HttpApi } from "effect/unstable/httpapi"
import type { ActorMethodInput, ActorMethodOutput, ActorMethods, ActorMethodState } from "tardie"

import {
  apiOf,
  RESERVED_ACTOR,
  ResumeRefused,
  type Accepted,
  type ActorSummary,
  type Append,
  type ThreadNode,
  type ThreadSummary,
  type EventRow,
  type Health,
  type MethodAccepted,
  type MethodSummary,
  type Projections,
  type TurnView
} from "./contract"
import { isProblem, NO_ANSWER, problemOf, ProblemError } from "./problem"
import { stream, type OpenEventSource, type StreamOptions } from "./stream"

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

// The titles a failure that carries no problem document shows. They stand where the server's own
// `title` would be, so a screen renders one field either way.
export const UNREACHABLE_TITLE = "Server Unreachable"

export const UNEXPECTED_RESPONSE_TITLE = "Unexpected Response"

export const SERVER_ERROR_TITLE = "Server Error"

export const SERVER_ERROR_DETAIL =
  "The server returned no error details. Check the `tdg dev` terminal and restart the server if needed."

export const UNREADABLE_EXCHANGE_TITLE = "Unreadable Exchange"

// One derived projection call, as much of its shape as the lookup below needs. The declaration's
// own types are what a caller sees (Client.projection); this is the untyped middle.
// The client HttpApiClient derives for one actor's API: the log's methods, the actor's projections
// keyed by name, and the health probe.
type GroupsOf<Api> = Api extends HttpApi.HttpApi<string, infer Groups> ? Groups : never

type DerivedApi<P extends Projections> = HttpApiClient.Client<GroupsOf<ReturnType<typeof apiOf<P>>>>

type ProjectionCall = (request: {
  readonly params: { readonly actor: string; readonly id: string }
  readonly query: unknown
}) => Effect.Effect<unknown, unknown>

export interface ClientOptions<P extends Projections = {}, M extends ActorMethods = ActorMethods> {
  // The server's address. A path on it is kept, so a server mounted under a prefix works.
  readonly baseUrl?: string | undefined
  // The bearer token, sent as an `authorization` header on every request (apps/server/src/http.ts,
  // layerAuth). The tail cannot carry it (stream.ts).
  readonly token?: string | undefined
  // Which actor's threads this client addresses. The default is the one name a v1 server reserves
  // for the assembly it compiled in (contract.ts, RESERVED_ACTOR).
  readonly actor?: string | undefined
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
  // methods preserves the selected actor's call types at this client boundary.
  readonly methods?: M | undefined
}

export interface EventsOptions {
  // The seq to read past. The server numbers events from 1, so `after: 40` starts at 41.
  readonly after?: number | undefined
  readonly limit?: number | undefined
  // Event type names, sent as one comma-joined `types` param.
  readonly types?: ReadonlyArray<string> | undefined
}

// What a caller states to follow a log: the tail's options, less the ones the client already holds.
export type FollowOptions = Omit<StreamOptions, "baseUrl" | "thread" | "actor" | "eventSource">

// The query one projection accepts, and what it answers: both read from the actor's own
// declaration, so a caller states what that projection states and gets back what it promises
// (contract.ts, projection).
export type ProjectionQuery<P extends Projections, Name extends keyof P> = SchemaStructType<P[Name]["params"]>

export type ProjectionResult<P extends Projections, Name extends keyof P> = P[Name]["result"]["Type"]

// MethodCall carries the caller-minted id and the selected declaration's input type.
export type MethodCall<M extends ActorMethods, Name extends keyof M> = {
  readonly id: string
  readonly input: ActorMethodInput<M[Name]>
}

type SchemaStructType<Fields> = Fields extends Schema.Struct.Fields ? Schema.Struct<Fields>["Type"] : never

export interface Client<P extends Projections = {}, M extends ActorMethods = ActorMethods> {
  readonly baseUrl: string
  // The actor every call addresses, resolved once at construction (ClientOptions, actor).
  readonly actor: string
  readonly actors: () => Promise<ReadonlyArray<ActorSummary>>
  readonly list: () => Promise<ReadonlyArray<ThreadSummary>>
  readonly tree: (thread: string) => Promise<ThreadNode>
  readonly events: (thread: string, options?: EventsOptions) => Promise<ReadonlyArray<EventRow>>
  // Appends one event to a thread's log. A brief is `{ type: "MessageReceived", id, text }`; the
  // platform requires nothing but `type` (contract.ts, Append).
  readonly append: (thread: string, event: Append) => Promise<Accepted>
  // methods lists the selected actor's callable interface and JSON Schema documents.
  readonly methods: () => Promise<ReadonlyArray<MethodSummary>>
  // invoke commits one declared method call and returns its durable handle.
  readonly invoke: <const Name extends keyof M & string>(
    thread: string,
    name: Name,
    call: MethodCall<M, Name>
  ) => Promise<MethodAccepted>
  // methodState reads the selected declaration's typed durable state.
  readonly methodState: <const Name extends keyof M & string>(
    thread: string,
    name: Name,
    call: string
  ) => Promise<ActorMethodState<ActorMethodOutput<M[Name]>>>
  // Resumes a failed turn by appending the TurnResumed its reactors already interpret. It is the
  // SDK's convenience rather than a route: the platform has no resume, because a resume is an
  // append like any other (resume, below).
  readonly resume: (thread: string, turn: string) => Promise<Accepted>
  readonly health: () => Promise<Health>
  // Reads one projection the actor declared. The name is one this client was built with, and the
  // query and the answer are that declaration's own types (client.test.ts, "a declared projection
  // serves and types").
  readonly projection: <const Name extends keyof P & string>(
    thread: string,
    name: Name,
    query?: ProjectionQuery<P, Name>
  ) => Promise<ProjectionResult<P, Name>>
  // Follows one thread's log and answers with the unsubscribe.
  readonly follow: (thread: string, options: FollowOptions) => (() => void)
}

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

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.catch(effect, (failure) => Effect.flatMap(problemErrorOf(failure), Effect.fail)))

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

// makeClient builds the client once. The derivation reads the declaration and compiles an encoder
// and a decoder per endpoint, so it happens at construction rather than per call.
export const makeClient = <const P extends Projections = {}, const M extends ActorMethods = ActorMethods>(
  options: ClientOptions<P, M> = {}
): Client<P, M> => {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const token = options.token
  // The derivation's own requirement is `HttpClient`, which the layer below provides, plus whatever
  // the API's middleware asks a client for. RequestProblems asks for nothing, so nothing is left to
  // provide; the compiler proves that for a stated declaration and cannot for a generic one, which
  // is what the annotation states here rather than at every call site.
  const derived = HttpApiClient.make(apiOf(options.projections ?? ({} as P)), {
    baseUrl,
    ...(token === undefined
      ? {}
      : { transformClient: (client: HttpClient.HttpClient) => HttpClient.mapRequest(client, HttpClientRequest.bearerToken(token)) })
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    options.fetch === undefined
      ? (self) => self
      : Effect.provideService(FetchHttpClient.Fetch, options.fetch)
  )
  // derived has no requirements for every concrete declaration, which a generic P cannot reduce.
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
  const api = Effect.runSync(derived as Effect.Effect<DerivedApi<P>>)
  // The actor this client addresses. One name today, because the server compiles one assembly in
  // and reserves that name for it (contract.ts, RESERVED_ACTOR); it is an option rather than a
  // literal at each call so a deploy that serves more than one is a client option, not a rewrite.
  const actor = options.actor ?? RESERVED_ACTOR
  const append = (thread: string, event: Append): Promise<Accepted> =>
    run(api.threads.append({ params: { actor, id: thread }, payload: event }))

  // turnsOf reads the `turns` projection through the derivation, which is where the resume
  // convenience gets the epoch it has to stamp. It is spelled by name rather than through
  // `projection` because `resume` is on every client while the declaration is not: a client built
  // for an actor that declares no `turns` says so instead of failing on an undefined call.
  const turnsOf = async (thread: string, turn: string): Promise<ReadonlyArray<TurnView>> => {
    const call = (api.projections as Record<string, ProjectionCall | undefined>)["turns"]
    if (call === undefined) {
      throw new ProblemError({
        ...ResumeRefused.of(
          "This client was built without a `turns` projection, so it cannot tell whether a turn failed."
        )
      })
    }
    // call erases the selected endpoint failure before run converts it to ProblemError.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    return await run(call({ params: { actor, id: thread }, query: { turn } })) as ReadonlyArray<TurnView>
  }

  return {
    baseUrl,
    actor,
    actors: () => run(api.actors.actors({})),
    list: () => run(api.threads.list({ params: { actor } })),
    tree: (thread) => run(api.threads.tree({ params: { actor, id: thread } })),
    events: (thread, events = {}) =>
      run(api.threads.events({ params: { actor, id: thread }, query: eventsQuery(events) })),
    append,
    methods: () => run(api.methods.methods({ params: { actor } })),
    invoke: (thread, name, call) =>
      run(api.methods.invoke({
        params: { actor, id: thread, method: name, call: call.id },
        payload: call.input
      })),
    methodState: (thread, name, call) =>
      run(api.methods.methodState({
        params: { actor, id: thread, method: name, call }
      })) as never,
    // A resume is an append, so the platform has no route for it and no guard over it. The check
    // below is advisory: it reads the turns projection to refuse the obvious mistake early and to
    // learn the epoch to stamp. A turn that fails between the read and the append still gets a
    // TurnResumed, and a TurnResumed for a turn that is not failed derives nothing, so a race costs
    // an inert event rather than a wrong outcome. A duplicate costs nothing either: the assembly
    // keys TurnResumed by turn and epoch, so a second one absorbs (packages/agent/src/events.ts,
    // agentKeys).
    resume: async (thread, turn) => {
      const views = await turnsOf(thread, turn)
      const view = views.find((candidate) => candidate.turn === turn)
      if (view === undefined) {
        throw new ProblemError({
          ...ResumeRefused.of(`No turn named ${JSON.stringify(turn)} has been served on this thread.`)
        })
      }
      if (view.status !== "failed") {
        throw new ProblemError({
          ...ResumeRefused.of(
            `turn ${JSON.stringify(turn)} cannot resume because its active epoch is ${view.status}`
          )
        })
      }
      // The next execution epoch, stamped the way the library stamps it
      // (packages/agent/src/resume.ts, resumeTurn).
      return append(thread, {
        type: "TurnResumed",
        turn,
        failedEpoch: view.epoch,
        epoch: view.epoch + 1
      })
    },
    health: () => run(api.health.healthz({})),
    // The derivation keys the projections group by name, and the name a caller passes is one of
    // those keys, so the lookup cannot miss. The types are recovered on the way out because an
    // index into a mapped record of endpoint methods is not one the compiler can narrow per call.
    projection: (thread, name, query) =>
      // ProjectionCall erases the selected endpoint failure before run converts it to ProblemError.
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      run((api.projections as Record<string, ProjectionCall>)[name]!({
        params: { actor, id: thread },
        query: query ?? {}
      })) as never,
    follow: (thread, follow) =>
      stream({
        ...follow,
        baseUrl,
        thread,
        actor,
        ...(options.eventSource === undefined ? {} : { eventSource: options.eventSource })
      })
  }
}
