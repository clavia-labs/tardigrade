import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Event } from "@clavia/tardigrade-core/event"

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

// The one actor this build serves. The server compiles one assembly into the binary, so the actor
// level is declared as a path parameter and answered for exactly this name: the shape is honest
// about what a deploy will vary, and no URL has to be taught twice when it does
// (apps/server/src/api.ts, actorOf).
export const RESERVED_ACTOR = "agent"

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

// A thread exists once its log has an event, so an empty log is the only unknown thread there is
// (apps/server/src/api.test.ts, "a log that never existed is the only 404").
export const UnknownThread = problemKind("unknown-thread", "Unknown Thread", 404)

// An actor is deployed code, and this build has one compiled in, so every name but the reserved one
// is an actor this server does not serve (apps/server/src/api.test.ts, "an actor nobody deployed is
// its own 404"). It is a separate failure from an unknown thread because the two say different
// things to a caller: one names code that is not here, the other a log that has never been written.
export const UnknownActor = problemKind("unknown-actor", "Unknown Actor", 404)

export const UnknownTurn = problemKind("unknown-turn", "Unknown Turn", 404)

// The library's guard is the API's 409: a turn resumes only from a failed active epoch, and its
// refusal carries the reason a caller acts on (apps/server/src/host.ts, ResumeRefused).
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

// One row of GET /v1/actors/:actor/threads: what a thread is, without its events. `parent` is absent for a root, and
// `lastAt` for a thread whose events carry no timestamp.
export const ThreadSummary = Schema.Struct({
  id: Schema.String,
  parent: Schema.optionalKey(Schema.String),
  events: Schema.Number,
  lastAt: Schema.optionalKey(Schema.Number),
  status: ThreadStatus
}).annotate({ identifier: "ThreadSummary" })

export type ThreadSummary = typeof ThreadSummary.Type

export interface ThreadNode extends ThreadSummary {
  readonly children: ReadonlyArray<ThreadNode>
}

// A summary with the threads it spawned, the shape GET /v1/actors/:actor/threads/:id/tree serves.
export const ThreadNode = Schema.Struct({
  ...ThreadSummary.fields,
  children: Schema.Array(Schema.suspend((): Schema.Codec<ThreadNode> => ThreadNode))
}).annotate({ identifier: "ThreadNode" })

export const TurnStatus = Schema.Literals(["pending", "completed", "failed", "parked"])

export type TurnStatus = typeof TurnStatus.Type

export const TurnView = Schema.Struct({
  turn: Schema.String,
  status: TurnStatus,
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "TurnView" })

export type TurnView = typeof TurnView.Type

// One row of GET /v1/actors/:actor/threads/:id/events. `seq` is the event's 1-based position in the whole log,
// assigned before any filter runs, so a `types` filter narrows the rows without renumbering them
// and `after` still means the same place (apps/server/src/api.test.ts, "after and limit page the
// log, and types filters without renumbering it").
export const EventRow = Schema.Struct({
  seq: Schema.Number,
  event: Event
}).annotate({ identifier: "EventRow" })

export type EventRow = typeof EventRow.Type

// The turn handle a delivery and a resume both answer with. 202 either way: the host dedups by
// message id, so a retrying client gets the same answer and never learns it retried. All three
// levels the request named are echoed, so a caller holds the whole address of the work it started
// without reassembling it from the URL.
export const Accepted = Schema.Struct({
  actor: Schema.String,
  thread: Schema.String,
  turn: Schema.String
}).annotate({ identifier: "Accepted" }).pipe(HttpApiSchema.status(202))

export type Accepted = typeof Accepted.Type

export const Health = Schema.Struct({
  status: Schema.Literals(["resting", "driving"]),
  dirty: Schema.Number
}).annotate({ identifier: "Health" })

export type Health = typeof Health.Type

// The message a client delivers. `id` is the dedup key end to end and becomes the turn id, so it is
// stated rather than defaulted: inventing one would turn a retry into a second turn
// (docs/how-to/server.md, "Redelivery is absorbed"). `input` and `data` are the canonical inbound's
// optional fields (packages/core/src/message.ts, MessageReceived).
export const Inbound = Schema.Struct({
  id: Schema.NonEmptyString,
  text: Schema.String,
  input: Schema.optionalKey(Schema.Unknown),
  data: Schema.optionalKey(Schema.Unknown)
}).annotate({ identifier: "Inbound" })

export type Inbound = typeof Inbound.Type

// A sequence number names a position in a log, so it is a whole number at or above zero. The query
// carries it as text and the declaration is what turns it into a number: a value that is not one is
// refused here rather than read as page one (apps/server/src/contract.test.ts, "a refused request
// is a problem document").
const Seq = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, { title: "at or above zero" }))
)

const SeqQuery = Schema.optionalKey(Seq)

// The actor level, on every route that reads or writes a thread. It is a parameter rather than the
// literal `agent` so the declaration states the shape a deploy will vary, and every route can refuse
// a name this build does not serve in the same way (apps/server/src/api.ts, actorOf).
const ActorParams = { actor: Schema.String }

const ThreadParams = { actor: Schema.String, id: Schema.String }

const TurnParams = { actor: Schema.String, id: Schema.String, turn: Schema.String }

export const threadsGroup = HttpApiGroup.make("threads").add(
  // Delivery is an append: a message is an event, and the log is where it lands, so the write side
  // of a thread is the same noun as its read side (docs/how-to/server.md, "Creation is delivery").
  HttpApiEndpoint.post("deliver", "/v1/actors/:actor/threads/:id/events", {
    params: ThreadParams,
    payload: Inbound,
    success: Accepted,
    error: [UnknownActor.schema]
  }),
  HttpApiEndpoint.get("list", "/v1/actors/:actor/threads", {
    params: ActorParams,
    success: Schema.Array(ThreadSummary),
    error: [UnknownActor.schema]
  }),
  HttpApiEndpoint.get("events", "/v1/actors/:actor/threads/:id/events", {
    params: ThreadParams,
    query: { after: SeqQuery, limit: SeqQuery, types: Schema.optionalKey(Schema.String) },
    success: Schema.Array(EventRow),
    error: [UnknownActor.schema, UnknownThread.schema]
  }),
  HttpApiEndpoint.get("turns", "/v1/actors/:actor/threads/:id/turns", {
    params: ThreadParams,
    query: { at: SeqQuery },
    success: Schema.Array(TurnView),
    error: [UnknownActor.schema, UnknownThread.schema]
  }),
  HttpApiEndpoint.get("turn", "/v1/actors/:actor/threads/:id/turns/:turn", {
    params: TurnParams,
    success: TurnView,
    error: [UnknownActor.schema, UnknownThread.schema, UnknownTurn.schema]
  }),
  HttpApiEndpoint.post("resume", "/v1/actors/:actor/threads/:id/turns/:turn/resume", {
    params: TurnParams,
    success: Accepted,
    error: [UnknownActor.schema, ResumeRefused.schema]
  }),
  HttpApiEndpoint.get("tree", "/v1/actors/:actor/threads/:id/tree", {
    params: ThreadParams,
    success: ThreadNode,
    error: [UnknownActor.schema, UnknownThread.schema]
  })
)

export const healthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("healthz", "/healthz", { success: Health })
)

// RequestProblems is the declaration's own guarantee: whatever a Schema in it refuses, the caller
// reads as a problem document. It is API-wide middleware rather than an error on each endpoint
// because the refusal happens before a handler runs, in framework code every endpoint shares, and
// because a rule stated once cannot be forgotten on the next endpoint added. The implementation is
// the server's (apps/server/src/contract.ts, layerRequestProblems).
export class RequestProblems extends HttpApiMiddleware.Service<RequestProblems>()(
  "tardigrade/server/RequestProblems",
  { error: InvalidRequest.schema }
) {}

export const Api = HttpApi.make("tardigrade").add(threadsGroup, healthGroup).middleware(RequestProblems)
  .annotateMerge(
    OpenApi.annotations({
      title: "Tardigrade",
      description:
        "Actors, threads, turns, and events: every read is a projection of a durable log, and every failure is an RFC 9457 problem document."
    })
  )
