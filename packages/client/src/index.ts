// The package's front door: the client, the tail, the error shape, and the wire types, so a
// consumer imports the types it renders and the calls that fetch them from one place.

export {
  DEFAULT_BASE_URL,
  makeClient,
  UNEXPECTED_RESPONSE_TITLE,
  UNREACHABLE_TITLE,
  UNREADABLE_EXCHANGE_TITLE,
  type Client,
  type ClientOptions,
  type EventsOptions,
  type FollowOptions
} from "./client"
export { isProblem, NO_ANSWER, problemOf, ProblemError } from "./problem"
export { CLOSED, stream, streamUrl, type EventSourceLike, type Frame, type OpenEventSource, type StreamOptions } from "./stream"

export type {
  Accepted,
  AgentNode,
  AgentStatus,
  AgentSummary,
  EventRow,
  Health,
  Inbound,
  Problem,
  TurnStatus,
  TurnView
} from "./contract"
export type { Event } from "@clavia/tardigrade-core/event"
