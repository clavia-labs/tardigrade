// The package's front door: the client, the tail, the error shape, and the wire types, so a
// consumer imports the types it renders and the calls that fetch them from one place.

export {
  DEFAULT_BASE_URL,
  makeClient,
  SERVER_ERROR_DETAIL,
  SERVER_ERROR_TITLE,
  UNEXPECTED_RESPONSE_TITLE,
  UNREACHABLE_TITLE,
  UNREADABLE_EXCHANGE_TITLE,
  type Client,
  type ClientOptions,
  type EventsOptions,
  type FollowOptions
} from "./client"
export { isProblem, NO_ANSWER, problemOf, ProblemError } from "./problem"
// The vocabulary's top level, and where the versioned routes live. A consumer that builds a URL by
// hand, or names the actor it addresses, reads them from here rather than spelling either again
// (contract.ts).
export { RESERVED_ACTOR, V1_PREFIX } from "./contract"
export { CLOSED, stream, streamUrl, type EventSourceLike, type Frame, type OpenEventSource, type StreamOptions } from "./stream"

export type {
  Accepted,
  ActorSummary,
  ThreadNode,
  ThreadStatus,
  ThreadSummary,
  EventRow,
  Health,
  Append,
  Problem,
  TurnStatus,
  TurnView
} from "./contract"
export type { Event } from "@clavia/tardigrade-core/event"
