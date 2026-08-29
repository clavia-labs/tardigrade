// The package's front door: the client, the tail, the error shape, and the wire types, so a
// consumer imports the types it renders and the calls that fetch them from one place.

export {
  DEFAULT_BASE_URL,
  DEFAULT_ACTOR_INSTANCE,
  makeControlClient,
  makeActorClient,
  SERVER_ERROR_DETAIL,
  SERVER_ERROR_TITLE,
  UNEXPECTED_RESPONSE_TITLE,
  UNREACHABLE_TITLE,
  UNREADABLE_EXCHANGE_TITLE,
  type ActorClient,
  type ActorClientOptions,
  type ControlClient,
  type ControlClientOptions,
  type CatalogPageOptions,
  type EventsOptions,
  type FollowOptions,
  type MethodCall,
  type ModelPageOptions
} from "./client"
export { isProblem, NO_ANSWER, problemOf, ProblemError } from "./problem"
// The vocabulary's top level, and where the versioned routes live. A consumer that builds a URL by
// hand reads them from here rather than spelling them again
// (contract.ts).
export {
  CATALOG_AVAILABILITY_FILTERS,
  MODEL_CATALOG_PRICE_SORTS,
  MODEL_CATALOG_SORT_ORDERS,
  MODEL_CATALOG_UNPRICED_ORDERS,
  V1_PREFIX
} from "./contract"
export { CLOSED, stream, streamUrl, type EventSourceLike, type Frame, type OpenEventSource, type StreamOptions } from "./stream"

export type {
  Accepted,
  ActorArtifact,
  ActorInstanceSummary,
  ActorMetadata,
  ActorSummary,
  Append,
  CatalogAvailabilityFilter,
  EventRow,
  Health,
  MethodAccepted,
  MethodSummary,
  MethodState,
  ModelCatalog,
  ModelCatalogPage,
  ModelCatalogPriceSort,
  ModelCatalogSortOrder,
  ModelCatalogUnpricedOrder,
  ModelPolicySummary,
  ProviderAvailability,
  ProviderCatalogPage,
  Problem,
  ThreadNode,
  ThreadStatus,
  ThreadSummary,
  TurnStatus,
  TurnView
} from "./contract"
export type { Event } from "@clavia/tardigrade-core/log/event"
