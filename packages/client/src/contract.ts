import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Event } from "@clavia/tardigrade-core/log/event"
import { ActorInstanceId } from "@clavia/tardigrade-core/communication/endpoint"

// V1_PREFIX prefixes every versioned route.
export const V1_PREFIX = "/v1"

// RESERVED_ACTOR is the internal name of the built-in actor mounted by the generic host.
export const RESERVED_ACTOR = "default"

// OPENAPI_PATH serves the generated OpenAPI document without authentication (apps/server/src/http.ts, UNAUTHENTICATED_PATHS).
export const OPENAPI_PATH = "/openapi.json"

// DOCS_PATH serves the API reference without authentication (apps/server/src/http.ts, UNAUTHENTICATED_PATHS).
export const DOCS_PATH = "/docs"

// PROBLEM_CONTENT_TYPE identifies RFC 9457 problem documents.
export const PROBLEM_CONTENT_TYPE = "application/problem+json"

// PROBLEM_TYPE_BASE prefixes each problem type URI.
export const PROBLEM_TYPE_BASE = "https://tardigrade.dev/problems/"

// Problem describes an RFC 9457 API failure.
export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail?: string
}

// problemKind declares a problem with literal type, title, and status fields (apps/server/src/contract.test.ts, "a problem response carries all four fields").
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

// InvalidRequest reports input that does not match an endpoint declaration.
export const InvalidRequest = problemKind("invalid-request", "Invalid Request", 400)

// UnknownThread reports a thread whose log has no ThreadCreated event (apps/server/src/api.test.ts, "a log that never existed is the only 404").
export const UnknownThread = problemKind("unknown-thread", "Unknown Thread", 404)

// UnknownActor reports an actor instance that no write has created.
export const UnknownActor = problemKind("unknown-actor", "Unknown Actor", 404)

// UnknownProjection reports a projection the actor did not declare.
export const UnknownProjection = problemKind("unknown-projection", "Unknown Projection", 404)

// UnknownMethod reports a method name the mounted actor did not declare.
export const UnknownMethod = problemKind("unknown-method", "Unknown Method", 404)

// UnknownMethodCall reports a call id the selected method cannot derive from the thread log.
export const UnknownMethodCall = problemKind("unknown-method-call", "Unknown Method Call", 404)

// ModelCatalogUnavailable reports an unavailable public model catalog.
export const ModelCatalogUnavailable = problemKind("model-catalog-unavailable", "Model Catalog Unavailable", 503)

// ResumeRefused reports a turn that the client cannot resume.
export const ResumeRefused = problemKind("resume-refused", "Resume Refused", 409)

// InvocationSettled reports that cancellation cannot change a completed or failed invocation.
export const InvocationSettled = problemKind("invocation-settled", "Invocation Settled", 409)

// RequestPart names the request locations validated by HttpApi.
export type RequestPart = "Params" | "Query" | "Payload" | "Headers"

const WHERE: Record<RequestPart, string> = {
  Params: "The path",
  Query: "The query",
  Payload: "The request body",
  Headers: "The request headers"
}

// invalidRequest describes the request location and fields that validation refused.
export const invalidRequest = (part: RequestPart, faults: ReadonlyArray<string>) =>
  InvalidRequest.of([`${WHERE[part]} is not what this endpoint accepts.`, ...faults].join(" "))

export const missingField = (field: string): string => `\`${field}\` is missing.`

export const unacceptableField = (field: string): string => `\`${field}\` is not a value it accepts.`

export const ThreadStatus = Schema.Literals(["settled", "running", "blocked", "failed"])

export type ThreadStatus = typeof ThreadStatus.Type

// ThreadSummary describes a thread without its event bodies.
export const ThreadSummary = Schema.Struct({
  id: Schema.String,
  parent: Schema.optionalKey(Schema.String),
  depth: Schema.Int,
  events: Schema.Finite,
  lastAt: Schema.optionalKey(Schema.Finite),
  status: ThreadStatus
}).annotate({ identifier: "ThreadSummary" })

export type ThreadSummary = typeof ThreadSummary.Type

// ActorThread identifies a thread in an actor and records its lineage.
export const ActorThread = Schema.Struct({
  id: Schema.String,
  parent: Schema.optionalKey(Schema.String),
  depth: Schema.Int
}).annotate({ identifier: "ActorThread" })

export type ActorThread = typeof ActorThread.Type

export const ThreadsSnapshot = Schema.Struct({
  type: Schema.Literal("ThreadsSnapshot"),
  threads: Schema.Array(ActorThread)
}).annotate({ identifier: "ThreadsSnapshot" })

export type ThreadsSnapshot = typeof ThreadsSnapshot.Type

export const ThreadAdded = Schema.Struct({
  type: Schema.Literal("ThreadAdded"),
  thread: ActorThread
}).annotate({ identifier: "ThreadAdded" })

export type ThreadAdded = typeof ThreadAdded.Type

export const ActorThreadsEvent = Schema.Union([ThreadsSnapshot, ThreadAdded])

export type ActorThreadsEvent = typeof ActorThreadsEvent.Type

export const ActorThreadsEventRow = Schema.Struct({
  seq: Schema.Finite,
  event: ActorThreadsEvent
}).annotate({ identifier: "ActorThreadsEventRow" })

export type ActorThreadsEventRow = typeof ActorThreadsEventRow.Type

export interface ThreadNode extends ThreadSummary {
  readonly children: ReadonlyArray<ThreadNode>
}

// ThreadNode adds child threads to a thread summary.
export const ThreadNode = Schema.Struct({
  ...ThreadSummary.fields,
  children: Schema.Array(Schema.suspend((): Schema.Codec<ThreadNode> => ThreadNode))
}).annotate({ identifier: "ThreadNode" })

export const TurnStatus = Schema.Literals(["pending", "completed", "failed", "cancelled", "parked"])

export type TurnStatus = typeof TurnStatus.Type

// TurnView describes a turn and its current execution epoch.
export const TurnView = Schema.Struct({
  turn: Schema.String,
  status: TurnStatus,
  epoch: Schema.Finite,
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "TurnView" })

export type TurnView = typeof TurnView.Type

// EventRow pairs an event with its stable log sequence (apps/server/src/api.test.ts, "after and limit page the log, and types filters without renumbering it").
export const EventRow = Schema.Struct({
  seq: Schema.Finite,
  event: Event
}).annotate({ identifier: "EventRow" })

export type EventRow = typeof EventRow.Type

// Accepted identifies the actor and thread that accepted an event for asynchronous reconciliation.
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
  call: Schema.String,
  deadlineAt: Schema.Finite
}).annotate({ identifier: "MethodAccepted" }).pipe(HttpApiSchema.status(202))

export type MethodAccepted = typeof MethodAccepted.Type

// CancellationRequest carries the caller's reason for stopping an invocation.
export const CancellationRequest = Schema.Struct({
  reason: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "CancellationRequest" })

export type CancellationRequest = typeof CancellationRequest.Type

const CancellationFields = {
  actor: Schema.String,
  thread: Schema.String,
  method: Schema.String,
  call: Schema.String
}

const CancellationRequestedResult = Schema.Struct({
  ...CancellationFields,
  status: Schema.Literal("requested")
}).annotate({ identifier: "CancellationRequestedResult" }).pipe(HttpApiSchema.status(202))

const CancellationCancelledResult = Schema.Struct({
  ...CancellationFields,
  status: Schema.Literal("cancelled")
}).annotate({ identifier: "CancellationCancelledResult" }).pipe(HttpApiSchema.status(200))

export type CancellationResult = typeof CancellationRequestedResult.Type | typeof CancellationCancelledResult.Type

// MethodState is the durable state any declared actor method can expose on the wire.
export const MethodState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("completed"), output: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    cause: Schema.Literals(["requested", "deadline"]),
    reason: Schema.optionalKey(Schema.String),
    deadlineAt: Schema.optionalKey(Schema.Finite)
  })
]).annotate({ identifier: "MethodState" })

export type MethodState = typeof MethodState.Type

// MethodSummary exposes one declared method, its cancellation capability, and standalone JSON Schemas for its input and output.
export const MethodSummary = Schema.Struct({
  name: Schema.String,
  cancellable: Schema.Boolean,
  timeoutMs: Schema.Finite,
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

// ModelCatalog describes the public provider and model snapshot.
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

// Append describes an event accepted by the platform. The actor defines every field except `type`.
export const Append = Schema.StructWithRest(
  Schema.Struct({ type: Schema.NonEmptyString }),
  [Schema.Record(Schema.String, Schema.Unknown)]
).annotate({ identifier: "Append" })

export type Append = typeof Append.Type

// Seq identifies a position in a log as a non-negative integer.
export const Seq = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, { title: "at or above zero" }))
)

const SeqQuery = Schema.optionalKey(Seq)

const RuntimeActorParams = { id: ActorInstanceId }

const RuntimeThreadParams = { ...RuntimeActorParams, thread: Schema.String }

const RuntimeMethodCallParams = { ...RuntimeThreadParams, method: Schema.String, call: Schema.String }

// runtimeGroup exposes metadata for the mounted actor.
export const runtimeGroup = HttpApiGroup.make("runtime").add(
  HttpApiEndpoint.get("metadata", "/v1/metadata", { success: ActorMetadata })
)

// threadsGroup exposes thread logs and lineage.
export const threadsGroup = HttpApiGroup.make("threads").add(
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
  HttpApiEndpoint.get("tree", "/v1/actors/:id/threads/:thread/tree", {
    params: RuntimeThreadParams,
    success: ThreadNode,
    error: [UnknownActor.schema, UnknownThread.schema]
  })
)

// methodsGroup exposes durable actor method calls.
export const methodsGroup = HttpApiGroup.make("methods").add(
  HttpApiEndpoint.get("methods", "/v1/methods", {
    success: Schema.Array(MethodSummary)
  }),
  HttpApiEndpoint.put("invoke", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call", {
    params: RuntimeMethodCallParams,
    query: { timeoutMs: Schema.optionalKey(Seq) },
    payload: Schema.Unknown,
    success: MethodAccepted,
    error: [InvalidRequest.schema, UnknownMethod.schema]
  }),
  HttpApiEndpoint.get("methodState", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call", {
    params: RuntimeMethodCallParams,
    query: {},
    success: MethodState,
    error: [UnknownActor.schema, UnknownThread.schema, UnknownMethod.schema, UnknownMethodCall.schema]
  }),
  HttpApiEndpoint.put("cancel", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call/cancellation", {
    params: RuntimeMethodCallParams,
    payload: CancellationRequest,
    success: [CancellationRequestedResult, CancellationCancelledResult],
    error: [
      InvalidRequest.schema,
      UnknownActor.schema,
      UnknownThread.schema,
      UnknownMethod.schema,
      UnknownMethodCall.schema,
      InvocationSettled.schema
    ]
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

// modelsGroup exposes paginated public provider and model discovery.
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

// ProjectionDeclaration defines a pure read over a thread log.
export interface ProjectionDeclaration {
  readonly params: Schema.Struct.Fields
  readonly result: Schema.Top
  // run accepts parameters inferred by projection.
  readonly run: (events: ReadonlyArray<Event>, params: never) => unknown
}

export type Projections = Record<string, ProjectionDeclaration>

// projection preserves the parameter and result types of a projection declaration.
export const projection = <Params extends Schema.Struct.Fields, Result extends Schema.Top>(
  declaration: {
    readonly params: Params
    readonly result: Result
    readonly run: (events: ReadonlyArray<Event>, params: Schema.Struct<Params>["Type"]) => Result["Type"]
  }
): typeof declaration => declaration

// projectionsOf preserves projection names and schemas.
export const projectionsOf = <const P extends Projections>(projections: P): P => projections

// projectionEndpoint creates an endpoint without widening its result schema.
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

// projectionEndpointsOf creates the endpoints mounted for a projection record.
const projectionEndpointsOf = <const P extends Projections>(
  projections: P
): readonly [ProjectionEndpoints<P>, ...ReadonlyArray<ProjectionEndpoints<P>>] =>
  Object.entries(projections).map(([name, declaration]) =>
    projectionEndpoint(name, declaration.params, declaration.result)
  ) as never

export const projectionsGroupOf = <const P extends Projections>(projections: P) =>
  HttpApiGroup.make("projections").add(...projectionEndpointsOf(projections))

// RequestProblems converts request schema failures into problem documents.
export class RequestProblems extends HttpApiMiddleware.Service<RequestProblems>()(
  "tardigrade/server/RequestProblems",
  { error: InvalidRequest.schema }
) {}

// actorApiOf declares the API for one mounted actor.
export const actorApiOf = <const P extends Projections>(projections: P) =>
  HttpApi.make("tardigrade-actor").add(modelsGroup, runtimeGroup, actorsGroup, threadsGroup, methodsGroup, projectionsGroupOf(projections), healthGroup)
    .middleware(RequestProblems)

// controlApi declares actor definition management operations.
export const controlApi = HttpApi.make("tardigrade-control").add(definitionsGroup).middleware(RequestProblems)

// apiOf combines actor, control, model, and health operations.
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

// Api declares the platform API without actor projections.
export const Api = apiOf({})
