import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"

import {
  Api,
  type Accepted,
  type AgentNode,
  type AgentSummary,
  type EventRow,
  type Health,
  type Inbound,
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
export const DEFAULT_BASE_URL = "http://localhost:4111"

// The titles a failure that carries no problem document shows. They stand where the server's own
// `title` would be, so a screen renders one field either way.
export const UNREACHABLE_TITLE = "Server Unreachable"

export const UNEXPECTED_RESPONSE_TITLE = "Unexpected Response"

export const UNREADABLE_EXCHANGE_TITLE = "Unreadable Exchange"

export interface ClientOptions {
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
}

export interface EventsOptions {
  // The seq to read past. The server numbers events from 1, so `after: 40` starts at 41.
  readonly after?: number | undefined
  readonly limit?: number | undefined
  // Event type names, sent as one comma-joined `types` param.
  readonly types?: ReadonlyArray<string> | undefined
}

// What a caller states to follow a log: the tail's options, less the two the client already holds.
export type FollowOptions = Omit<StreamOptions, "baseUrl" | "agent" | "eventSource">

export interface Client {
  readonly baseUrl: string
  readonly list: () => Promise<ReadonlyArray<AgentSummary>>
  readonly tree: (agent: string) => Promise<AgentNode>
  readonly events: (agent: string, options?: EventsOptions) => Promise<ReadonlyArray<EventRow>>
  readonly turns: (agent: string, at?: number) => Promise<ReadonlyArray<TurnView>>
  readonly turn: (agent: string, turn: string) => Promise<TurnView>
  readonly deliver: (agent: string, message: Inbound) => Promise<Accepted>
  readonly resume: (agent: string, turn: string) => Promise<Accepted>
  readonly health: () => Promise<Health>
  // Follows one agent's log and answers with the unsubscribe.
  readonly follow: (agent: string, options: FollowOptions) => (() => void)
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
export const makeClient = (options: ClientOptions = {}): Client => {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const token = options.token
  const api = Effect.runSync(
    HttpApiClient.make(Api, {
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
  )
  return {
    baseUrl,
    list: () => run(api.agents.list({})),
    tree: (agent) => run(api.agents.tree({ params: { id: agent } })),
    events: (agent, events = {}) => run(api.agents.events({ params: { id: agent }, query: eventsQuery(events) })),
    turns: (agent, at) => run(api.agents.turns({ params: { id: agent }, query: at === undefined ? {} : { at } })),
    turn: (agent, turn) => run(api.agents.turn({ params: { id: agent, turn } })),
    deliver: (agent, message) => run(api.agents.deliver({ params: { id: agent }, payload: message })),
    resume: (agent, turn) => run(api.agents.resume({ params: { id: agent, turn } })),
    health: () => run(api.health.healthz({})),
    follow: (agent, follow) =>
      stream({
        ...follow,
        baseUrl,
        agent,
        ...(options.eventSource === undefined ? {} : { eventSource: options.eventSource })
      })
  }
}
