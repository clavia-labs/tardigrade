import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Event } from "@clavia/tardigrade-core/log/event"

// The API as a value. Every JSON route is an HttpApiEndpoint with its path params, query, success
// schema, and error schemas, so the router, the OpenAPI document, and the derived client all read
// one declaration and cannot disagree (apps/server/src/contract.test.ts, "the OpenAPI document
// lists every endpoint"). The declaration lives in this package because three consumers read it and
// only one of them is the server: the server implements it (apps/server/src/api.ts), the client
// derives from it (client.ts), and a browser imports its types. Nothing here performs IO.
//
// The SSE route is absent on purpose. HttpApi is request-and-response shaped, and the tail is a
// connection with a cursor, so it stays an HttpRouter route beside this app
// (apps/server/src/api.ts, layerStream) and a hand-written helper follows it (stream.ts).
//
// The vocabulary is four levels, and every route names the first three. An actor is the deployed
// code, addressed by name. A thread is one log under an actor, resumable forever. A turn is one
// inbound message and the work it caused. An event is one fact. The resource a route reads is the
// thread; the actor above it is what a deploy will vary.

// Where every versioned route lives. The unversioned paths are the three that describe the process
// rather than its resources: /healthz, OPENAPI_PATH, and DOCS_PATH (apps/server/src/http.ts,
// UNAUTHENTICATED_PATHS). The endpoint paths below are written out in full rather than built from
// this, because a declaration a reader can grep for is worth more than a spared repetition; this
// constant is what a hand-written helper follows the declaration with (stream.ts, streamUrl).
export const V1_PREFIX = "/v1"

// RESERVED_ACTOR is the internal name of the built-in actor mounted by the generic host.
export const RESERVED_ACTOR = "default"

// Where the derived OpenAPI document is served, and where the reference page renders it. Both are
// open even when a token is set (apps/server/src/http.ts, UNAUTHENTICATED_PATHS), because a
// document that describes the door should not need the key.
export const OPENAPI_PATH = "/openapi.json"

export const DOCS_PATH = "/docs"

export const PROBLEM_CONTENT_TYPE = "application/problem+json"

// The base of the `type` URI in a problem document. RFC 9457 wants a URI that identifies the error
// kind; a client matches on it rather than on the human title.
export const PROBLEM_TYPE_BASE = "https://tardigrade.dev/problems/"

// One RFC 9457 problem document, the only failure shape this API answers with.
export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail?: string
}

// problemKind declares one failure as RFC 9457 problem+json. The three fields a client matches on
// are literals, which is what makes the document its own discriminator: an endpoint declaring two
// failures encodes the one whose `type` matches, so the union never renders a 404 as a 400
// (apps/server/src/contract.test.ts, "a problem response carries all four fields").
const problemKind = <const Kind extends string, const Title extends string, const Status extends number>(
  kind: Kind,
  title: Title,
  status: Status
) => {
  const type = `${PROBLEM_TYPE_BASE}${kind}` as const
  return {
    schema: Schema.Struct({
      type: Schema.Literal(type),
      title: Schema.Literal(title),
      status: Schema.Literal(status),
      detail: Schema.optionalKey(Schema.String)
    }).annotate({ identifier: `Problem${title.replace(/ /g, "")}` }).pipe(
      HttpApiSchema.status(status),
      HttpApiSchema.asJson({ contentType: PROBLEM_CONTENT_TYPE })
    ),
    of: (detail: string) => ({ type, title, status, detail })
  }
}

// What a request that does not match its declaration answers with. A caller who wrote `after=soon`
// or left out `text` asked for something, and answering page one, or inventing a message id, hides
// the mistake behind plausible data (apps/server/src/contract.test.ts, "a refused request is a
// problem document").
export const InvalidRequest = problemKind("invalid-request", "Invalid Request", 400)

// A thread exists once its log has its ThreadCreated event, so an empty log is the only unknown thread there is (apps/server/src/api.test.ts, "a log that never existed is the only 404").
export const UnknownThread = problemKind("unknown-thread", "Unknown Thread", 404)

// UnknownActor reports an actor instance that no write has created.
export const UnknownActor = problemKind("unknown-actor", "Unknown Actor", 404)

// A name the actor never declared. The platform mounts what an actor declares and nothing else, so
// this is the answer for any other name under a thread, and its detail lists the names that do
// exist (apps/server/src/api.ts, layerProjections).
export const UnknownProjection = problemKind("unknown-projection", "Unknown Projection", 404)

// UnknownMethod reports a method name the mounted actor did not declare.
export const UnknownMethod = problemKind("unknown-method", "Unknown Method", 404)

// UnknownMethodCall reports a call id the selected method cannot derive from the thread log.
export const UnknownMethodCall = problemKind("unknown-method-call", "Unknown Method Call", 404)

// ModelCatalogUnavailable reports that neither the source nor the last valid cached snapshot could
// supply the public model directory.
export const ModelCatalogUnavailable = problemKind("model-catalog-unavailable", "Model Catalog Unavailable", 503)

// A resume refused before it was sent. The platform has no resume route: a resume is an appended
// TurnResumed like any other event, and the guard that a turn's active epoch must be failed is the
// SDK's convenience rather than the server's rule (client.ts, resume).
export const ResumeRefused = problemKind("resume-refused", "Resume Refused", 409)

// The parts of a request a declaration can refuse, named the way the framework names them
// (HttpApiError.HttpApiSchemaError, kind). `Body` and `ResponseHeaders` are absent because those
// are the server encoding its own answer: a failure there is a defect of the server's, not a bad
// request.
export type RequestPart = "Params" | "Query" | "Payload" | "Headers"

const WHERE: Record<RequestPart, string> = {
  Params: "The path",
  Query: "The query",
  Payload: "The request body",
  Headers: "The request headers"
}

// invalidRequest states which part of the request was refused and, where the refusal names fields,
// which fields. The detail is prose a caller can act on rather than a rendered schema issue: a
// client reads `type` to branch and `detail` to show a person (docs/how-to/server.md, "Endpoints").
export const invalidRequest = (part: RequestPart, faults: ReadonlyArray<string>) =>
  InvalidRequest.of([`${WHERE[part]} is not what this endpoint accepts.`, ...faults].join(" "))

export const missingField = (field: string): string => `\`${field}\` is missing.`

export const unacceptableField = (field: string): string => `\`${field}\` is not a value it accepts.`

export const ThreadStatus = Schema.Literals(["settled", "running", "blocked", "failed"])

export type ThreadStatus = typeof ThreadStatus.Type

// One row of GET /v1/threads: what a thread is, without its events. `parent` is absent for a root, and
// `lastAt` for a thread whose events carry no timestamp.
export const ThreadSummary = Schema.Struct({
  id: Schema.String,
  parent: Schema.optionalKey(Schema.String),
  depth: Schema.Int,
  events: Schema.Finite,
  lastAt: Schema.optionalKey(Schema.Finite),
  status: ThreadStatus
}).annotate({ identifier: "ThreadSummary" })

export type ThreadSummary = typeof ThreadSummary.Type

export interface ThreadNode extends ThreadSummary {
  readonly children: ReadonlyArray<ThreadNode>
}

// A summary with the threads it spawned, the shape GET /v1/threads/:id/tree serves.
export const ThreadNode = Schema.Struct({
  ...ThreadSummary.fields,
  children: Schema.Array(Schema.suspend((): Schema.Codec<ThreadNode> => ThreadNode))
}).annotate({ identifier: "ThreadNode" })

export const TurnStatus = Schema.Literals(["pending", "completed", "failed", "parked"])

export type TurnStatus = typeof TurnStatus.Type

// `epoch` is the execution epoch the turn's active attempt belongs to, zero until an operator has
// resumed it. It is on the wire because resuming stamps the next one, and a caller that cannot read
// the current epoch cannot name the next (client.ts, resume; packages/code/src/execution/turns.ts,
// turnEpochOf).
export const TurnView = Schema.Struct({
  turn: Schema.String,
  status: TurnStatus,
  epoch: Schema.Finite,
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "TurnView" })

export type TurnView = typeof TurnView.Type

// One row of GET /v1/threads/:id/events. `seq` is the event's 1-based position in the whole log,
// assigned before any filter runs, so a `types` filter narrows the rows without renumbering them
// and `after` still means the same place (apps/server/src/api.test.ts, "after and limit page the
// log, and types filters without renumbering it").
export const EventRow = Schema.Struct({
  seq: Schema.Finite,
  event: Event
}).annotate({ identifier: "EventRow" })

export type EventRow = typeof EventRow.Type

// What an append answers: the thread the request named. 202 because the event is committed and
// the settle loop takes it from there, and because the actor's own key absorbs a duplicate, so a
// retrying caller gets this same answer and never learns it retried. Nothing turn-shaped is echoed:
// a turn is the actor's reading of the log, and the caller already holds whatever id it sent.
export const Accepted = Schema.Struct({
  actor: Schema.String,
  thread: Schema.String
}).annotate({ identifier: "Accepted" }).pipe(HttpApiSchema.status(202))

export type Accepted = typeof Accepted.Type

// MethodAccepted identifies the method call committed for asynchronous reconciliation.
export const MethodAccepted = Schema.Struct({
  actor: Schema.String,
  thread: Schema.String,
  method: Schema.String,
  call: Schema.String
}).annotate({ identifier: "MethodAccepted" }).pipe(HttpApiSchema.status(202))

export type MethodAccepted = typeof MethodAccepted.Type

// MethodState is the durable state any declared actor method can expose on the wire.
export const MethodState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("completed"), output: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String })
]).annotate({ identifier: "MethodState" })

export type MethodState = typeof MethodState.Type

// MethodSummary exposes one declared method and standalone JSON Schemas for its input and output.
export const MethodSummary = Schema.Struct({
  name: Schema.String,
  inputSchema: Schema.Unknown,
  outputSchema: Schema.Unknown
}).annotate({ identifier: "MethodSummary" })

export type MethodSummary = typeof MethodSummary.Type

export const Health = Schema.Struct({
  status: Schema.Literals(["resting", "driving"]),
  dirty: Schema.Finite
}).annotate({ identifier: "Health" })

export type Health = typeof Health.Type

// ActorMetadata describes the actor and storage mounted at this runtime origin.
export const ActorMetadata = Schema.Struct({
  name: Schema.String,
  storage: Schema.Struct({
    kind: Schema.String,
    location: Schema.optionalKey(Schema.String)
  })
}).annotate({ identifier: "ActorMetadata" })

export type ActorMetadata = typeof ActorMetadata.Type

export const ActorSummary = Schema.Struct({
  name: Schema.String,
  builtIn: Schema.Boolean,
  digest: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "ActorSummary" })

export type ActorSummary = typeof ActorSummary.Type

export const ActorInstanceSummary = Schema.Struct({
  id: Schema.String,
  definition: Schema.String
}).annotate({ identifier: "ActorInstanceSummary" })

export type ActorInstanceSummary = typeof ActorInstanceSummary.Type

const ModelCatalogRate = Schema.Finite.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, { title: "non-negative" }))
)

const ModelTokenCount = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value > 0, { title: "positive" }))
)

export const ModelCatalogPricing = Schema.Struct({
  promptUsdPerToken: ModelCatalogRate,
  completionUsdPerToken: ModelCatalogRate,
  cachedPromptUsdPerToken: Schema.optionalKey(ModelCatalogRate),
  cacheWritePromptUsdPerToken: Schema.optionalKey(ModelCatalogRate)
}).annotate({ identifier: "ModelCatalogPricing" })

export const ModelCatalogMetadata = Schema.Struct({
  contextWindowTokens: Schema.optionalKey(ModelTokenCount),
  maxOutputTokens: Schema.optionalKey(ModelTokenCount),
  pricing: Schema.optionalKey(ModelCatalogPricing),
  toolCall: Schema.optionalKey(Schema.Boolean),
  structuredOutput: Schema.optionalKey(Schema.Boolean),
  inputModalities: Schema.optionalKey(Schema.Array(Schema.String)),
  outputModalities: Schema.optionalKey(Schema.Array(Schema.String))
}).annotate({ identifier: "ModelCatalogMetadata" })

export const ModelCatalogModel = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.String),
  metadata: ModelCatalogMetadata
}).annotate({ identifier: "ModelCatalogModel" })

export const ModelCatalogProvider = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  api: Schema.optionalKey(Schema.String),
  npm: Schema.optionalKey(Schema.String),
  env: Schema.Array(Schema.String),
  models: Schema.Array(ModelCatalogModel)
}).annotate({ identifier: "ModelCatalogProvider" })

// ModelCatalog is the public provider and model snapshot. Its source revision identifies the
// upstream data, while status says whether this process refreshed it or served its last valid copy.
export const ModelCatalog = Schema.Struct({
  source: Schema.Literal("models.dev"),
  revision: Schema.NonEmptyString,
  refreshedAt: Schema.Finite,
  status: Schema.Literals(["fresh", "cached"]),
  providers: Schema.Array(ModelCatalogProvider)
}).annotate({ identifier: "ModelCatalog" })

export type ModelCatalog = typeof ModelCatalog.Type

export const ModelPolicySummary = Schema.Struct({
  default: Schema.optionalKey(Schema.Struct({
    provider: Schema.NonEmptyString,
    model_id: Schema.NonEmptyString
  })),
  allow: Schema.Union([
    Schema.Literal("*"),
    Schema.Array(Schema.Struct({
      provider: Schema.NonEmptyString,
      model_ids: Schema.Union([Schema.Literal("*"), Schema.Array(Schema.NonEmptyString)])
    }))
  ])
}).annotate({ identifier: "ModelPolicySummary" })

export type ModelPolicySummary = typeof ModelPolicySummary.Type

const CatalogPageFields = {
  revision: Schema.NonEmptyString,
  status: Schema.Literals(["fresh", "cached"]),
  refreshed_at: Schema.Finite,
  policy: ModelPolicySummary,
  total: Schema.Int,
  limit: Schema.Int,
  next_cursor: Schema.optionalKey(Schema.String)
}

export const ProviderAvailability = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available") }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["not_configured", "credential_missing"])
  })
]).annotate({ identifier: "ProviderAvailability" })

export type ProviderAvailability = typeof ProviderAvailability.Type

export const CATALOG_AVAILABILITY_FILTERS = ["all", "available"] as const
export type CatalogAvailabilityFilter = typeof CATALOG_AVAILABILITY_FILTERS[number]

export const ProviderCatalogItem = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  availability: ProviderAvailability,
  protocol: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
  env: Schema.Array(Schema.String),
  required: Schema.Array(Schema.String),
  optional: Schema.Array(Schema.String)
}).annotate({ identifier: "ProviderCatalogItem" })

export const ProviderCatalogPage = Schema.Struct({
  ...CatalogPageFields,
  items: Schema.Array(ProviderCatalogItem)
}).annotate({ identifier: "ProviderCatalogPage" })

export type ProviderCatalogPage = typeof ProviderCatalogPage.Type

export const ModelCatalogItem = Schema.Struct({
  provider: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.String),
  metadata: ModelCatalogMetadata
}).annotate({ identifier: "ModelCatalogItem" })

export const ModelCatalogPage = Schema.Struct({
  ...CatalogPageFields,
  items: Schema.Array(ModelCatalogItem)
}).annotate({ identifier: "ModelCatalogPage" })

export type ModelCatalogPage = typeof ModelCatalogPage.Type

export const MODEL_CATALOG_PRICE_SORTS = [
  "promptUsdPerToken",
  "completionUsdPerToken",
  "cachedPromptUsdPerToken",
  "cacheWritePromptUsdPerToken"
] as const

export type ModelCatalogPriceSort = typeof MODEL_CATALOG_PRICE_SORTS[number]

export const MODEL_CATALOG_SORT_ORDERS = ["asc", "desc"] as const
export type ModelCatalogSortOrder = typeof MODEL_CATALOG_SORT_ORDERS[number]

export const MODEL_CATALOG_UNPRICED_ORDERS = ["first", "last"] as const
export type ModelCatalogUnpricedOrder = typeof MODEL_CATALOG_UNPRICED_ORDERS[number]

export const ActorArtifact = Schema.Struct({
  manifest: Schema.Struct({
    schema: Schema.Literal(3),
    name: Schema.String,
    module: Schema.String,
    digest: Schema.String
  }),
  module: Schema.String
}).annotate({ identifier: "ActorArtifact" })

export type ActorArtifact = typeof ActorArtifact.Type

// One event to append. `type` is the only field the platform requires, because an event is one fact
// and what its other fields mean is the actor's own knowledge: a brief is
// `{ type: "MessageReceived", id, text }`, and a resume is a `TurnResumed`. The platform stamps `at`
// when the caller states none and otherwise passes the fact through untouched.
//
// Duplicate suppression is the actor's too, keyed by its own `keyOf`: a MessageReceived dedups on
// `id`, so a retried brief is absorbed rather than started twice (packages/core/src/communication/message.ts,
// messageKeys; docs/how-to/server.md, "Redelivery is absorbed").
export const Append = Schema.StructWithRest(
  Schema.Struct({ type: Schema.NonEmptyString }),
  [Schema.Record(Schema.String, Schema.Unknown)]
).annotate({ identifier: "Append" })

export type Append = typeof Append.Type

// A sequence number names a position in a log, so it is a whole number at or above zero. The query
// carries it as text and the declaration is what turns it into a number: a value that is not one is
// refused here rather than read as page one (apps/server/src/contract.test.ts, "a refused request
// is a problem document").
export const Seq = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, { title: "at or above zero" }))
)

const SeqQuery = Schema.optionalKey(Seq)

const RuntimeActorParams = { id: Schema.String }

const RuntimeThreadParams = { ...RuntimeActorParams, thread: Schema.String }

const RuntimeMethodCallParams = { ...RuntimeThreadParams, method: Schema.String, call: Schema.String }

// runtimeGroup describes the actor mounted at this runtime origin.
export const runtimeGroup = HttpApiGroup.make("runtime").add(
  HttpApiEndpoint.get("metadata", "/v1/metadata", { success: ActorMetadata })
)

// threadsGroup declares the platform's raw log operations: list threads, append an event, and read events back.
export const threadsGroup = HttpApiGroup.make("threads").add(
  // Envelope is an append: a message is an event, and the log is where it lands, so the write side
  // of a thread is the same noun as its read side (docs/how-to/server.md, "Creation is delivery").
  HttpApiEndpoint.post("append", "/v1/actors/:id/threads/:thread/events", {
    params: RuntimeThreadParams,
    payload: Append,
    success: Accepted
  }),
  HttpApiEndpoint.get("list", "/v1/actors/:id/threads", {
    params: RuntimeActorParams,
    success: Schema.Array(ThreadSummary),
    error: [UnknownActor.schema]
  }),
  HttpApiEndpoint.get("events", "/v1/actors/:id/threads/:thread/events", {
    params: RuntimeThreadParams,
    query: { after: SeqQuery, limit: SeqQuery, types: Schema.optionalKey(Schema.String) },
    success: Schema.Array(EventRow),
    error: [UnknownActor.schema, UnknownThread.schema]
  }),
  // The tree reads the whole family because each thread owns its identity while parent addresses resolve against the other ThreadCreated records in the actor's listing.
  HttpApiEndpoint.get("tree", "/v1/actors/:id/threads/:thread/tree", {
    params: RuntimeThreadParams,
    success: ThreadNode,
    error: [UnknownActor.schema, UnknownThread.schema]
  })
)

// methodsGroup turns typed actor input into a durable event and projects each call from the same log.
export const methodsGroup = HttpApiGroup.make("methods").add(
  HttpApiEndpoint.get("methods", "/v1/methods", {
    success: Schema.Array(MethodSummary)
  }),
  HttpApiEndpoint.put("invoke", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call", {
    params: RuntimeMethodCallParams,
    payload: Schema.Unknown,
    success: MethodAccepted,
    error: [InvalidRequest.schema, UnknownMethod.schema]
  }),
  HttpApiEndpoint.get("methodState", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call", {
    params: RuntimeMethodCallParams,
    success: MethodState,
    error: [UnknownActor.schema, UnknownThread.schema, UnknownMethod.schema, UnknownMethodCall.schema]
  })
)

export const healthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("healthz", "/healthz", { success: Health })
)

export const definitionsGroup = HttpApiGroup.make("definitions").add(
  HttpApiEndpoint.get("definitions", "/v1/definitions", { success: Schema.Array(ActorSummary) }),
  HttpApiEndpoint.put("pushDefinition", "/v1/definitions", {
    payload: ActorArtifact,
    success: ActorSummary,
    error: [InvalidRequest.schema]
  })
)

export const actorsGroup = HttpApiGroup.make("actors").add(
  HttpApiEndpoint.get("actors", "/v1/actors", { success: Schema.Array(ActorInstanceSummary) }),
  HttpApiEndpoint.put("ensureActor", "/v1/actors/:id", {
    params: RuntimeActorParams,
    success: ActorInstanceSummary
  }),
  HttpApiEndpoint.get("actor", "/v1/actors/:id", {
    params: RuntimeActorParams,
    success: ActorInstanceSummary,
    error: [UnknownActor.schema]
  })
)

const CatalogQuery = {
  search: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int),
  availability: Schema.optionalKey(Schema.Literals(CATALOG_AVAILABILITY_FILTERS))
}

// modelsGroup exposes paginated public provider and model discovery independently of private routes and credentials.
export const modelsGroup = HttpApiGroup.make("models").add(
  HttpApiEndpoint.get("providers", "/v1/providers", {
    query: CatalogQuery,
    success: ProviderCatalogPage,
    error: [ModelCatalogUnavailable.schema, InvalidRequest.schema]
  }),
  HttpApiEndpoint.get("models", "/v1/models", {
    query: {
      ...CatalogQuery,
      provider: Schema.optionalKey(Schema.String),
      sort: Schema.optionalKey(Schema.Literals(MODEL_CATALOG_PRICE_SORTS)),
      order: Schema.optionalKey(Schema.Literals(MODEL_CATALOG_SORT_ORDERS)),
      unpriced: Schema.optionalKey(Schema.Literals(MODEL_CATALOG_UNPRICED_ORDERS))
    },
    success: ModelCatalogPage,
    error: [ModelCatalogUnavailable.schema, InvalidRequest.schema]
  })
)

// A projection is a pure read of one thread's events, declared by the actor whose reactors wrote
// them. The platform holds the log and mounts what the actor declares; what the events mean is the
// actor's own knowledge, so the declaration lives beside its reactors (apps/server/src/actor.ts).
//
// `run` is a projection in the framework's sense: pure over the event set, recomputed per request,
// never stored. Nothing here performs IO, and a prefix of a log is a valid argument.
export interface ProjectionDeclaration {
  readonly params: Schema.Struct.Fields
  readonly result: Schema.Top
  // `never` is the widest parameter a constraint can ask for: it accepts a `run` typed against its
  // own decoded query, which is what `projection` below infers for an author.
  readonly run: (events: ReadonlyArray<Event>, params: never) => unknown
}

export type Projections = Record<string, ProjectionDeclaration>

// projection is how an actor writes one, and exists so `run` is inferred rather than annotated: the
// query it receives is `params` decoded, and what it answers is `result`'s type.
export const projection = <Params extends Schema.Struct.Fields, Result extends Schema.Top>(
  declaration: {
    readonly params: Params
    readonly result: Result
    readonly run: (events: ReadonlyArray<Event>, params: Schema.Struct<Params>["Type"]) => Result["Type"]
  }
): typeof declaration => declaration

// projectionsOf preserves the names and schemas used to build the projection routes.
export const projectionsOf = <const P extends Projections>(projections: P): P => projections

// One endpoint from one declaration. The schemas are type parameters of this function rather than
// fields reached through one declaration parameter, because inference through an indexed access
// widens `success` to `Schema.Top` and the derived client then answers `unknown`.
const projectionEndpoint = <
  const Name extends string,
  Params extends Schema.Struct.Fields,
  Result extends Schema.Top
>(name: Name, params: Params, result: Result) =>
  HttpApiEndpoint.get(name, `/v1/actors/:id/threads/:thread/projections/${name}` as const, {
    params: RuntimeThreadParams,
    query: params,
    success: result,
    error: [UnknownActor.schema, UnknownThread.schema]
  })

export type ProjectionEndpoint<Name extends string, D extends ProjectionDeclaration> = ReturnType<
  typeof projectionEndpoint<Name, D["params"], D["result"]>
>

export type ProjectionEndpoints<P extends Projections> = {
  readonly [Name in keyof P & string]: ProjectionEndpoint<Name, P[Name]>
}[keyof P & string]

// The endpoints a declaration mounts. The assertion is about arity, not shape: the element type is
// derived from the same record the values are built from, and a loop over `Object.entries` cannot
// carry a key's literal type, which is what `add` needs to key the group by name. An actor that
// declares nothing yields a group with no endpoints, which is what it should.
const projectionEndpointsOf = <const P extends Projections>(
  projections: P
): readonly [ProjectionEndpoints<P>, ...ReadonlyArray<ProjectionEndpoints<P>>] =>
  Object.entries(projections).map(([name, declaration]) =>
    projectionEndpoint(name, declaration.params, declaration.result)
  ) as never

export const projectionsGroupOf = <const P extends Projections>(projections: P) =>
  HttpApiGroup.make("projections").add(...projectionEndpointsOf(projections))

// RequestProblems is the declaration's own guarantee: whatever a Schema in it refuses, the caller
// reads as a problem document. It is API-wide middleware rather than an error on each endpoint
// because the refusal happens before a handler runs, in framework code every endpoint shares, and
// because a rule stated once cannot be forgotten on the next endpoint added. The implementation is
// the server's (apps/server/src/contract.ts, layerRequestProblems).
export class RequestProblems extends HttpApiMiddleware.Service<RequestProblems>()(
  "tardigrade/server/RequestProblems",
  { error: InvalidRequest.schema }
) {}

// actorApiOf declares the runtime mounted at one origin.
export const actorApiOf = <const P extends Projections>(projections: P) =>
  HttpApi.make("tardigrade-actor").add(modelsGroup, runtimeGroup, actorsGroup, threadsGroup, methodsGroup, projectionsGroupOf(projections), healthGroup)
    .middleware(RequestProblems)

// controlApi declares the host operations that manage several actors.
export const controlApi = HttpApi.make("tardigrade-control").add(definitionsGroup).middleware(RequestProblems)

// apiOf combines the mounted runtime, control plane, and health probe served by one process.
export const apiOf = <const P extends Projections>(projections: P) =>
  HttpApi.make("tardigrade").add(
    modelsGroup,
    runtimeGroup,
    definitionsGroup,
    actorsGroup,
    threadsGroup,
    methodsGroup,
    projectionsGroupOf(projections),
    healthGroup
  )
    .middleware(RequestProblems)
    .annotateMerge(
      OpenApi.annotations({
        title: "Tardigrade",
        description:
          "The mounted actor exposes durable methods over thread logs. The actor registry manages hosted actors separately. Raw events and declared projections remain available for inspection. Every failure is an RFC 9457 problem document."
      })
    )

// The platform's own API, with no actor mounted. It is what a consumer that reads the log alone
// derives from (client.ts, makeActorClient), and the group identifiers it carries are the ones every
// build shares, so a handler written against it serves an API with projections too.
export const Api = apiOf({})
