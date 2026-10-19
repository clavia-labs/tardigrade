import { Cause, Effect, Layer, Schema, type Stream } from "effect"
import type { ExecutionStreamPolicy, ExecutionUpdate } from "@clavia/tardigrade-core"
import { executionStreamSse } from "./execution-stream-sse"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ActorCommitError, ActorReplayError, InitialState, StateInitialisationError, InvalidMessage, InvocationNotFound, MessageConflict, WatchdogTerminalError, type MessageReceipt } from "@clavia/tardigrade-core"
import type { MessageDelivery } from "@clavia/tardigrade-core"
import type { ThreadRequest, ThreadCoordinate } from "@clavia/tardigrade-core"

interface HttpThread {
  readonly coordinate: ThreadCoordinate
  readonly receipt: (id: string) => Effect.Effect<MessageReceipt | undefined, Error>
}
export interface HttpHost {
  readonly execution?: { readonly stream: Stream.Stream<ExecutionUpdate>; readonly policy: ExecutionStreamPolicy }
  readonly actor: string
  readonly send: (message: MessageDelivery) => Effect.Effect<MessageReceipt, Error>
  readonly allocateRootThread: (input: Omit<ThreadRequest, "parent" | "placement">) => Effect.Effect<HttpThread, Error>
  readonly allocateChildThread: (input: Omit<ThreadRequest, "instance" | "parent" | "placement"> & { readonly parent: ThreadCoordinate }) => Effect.Effect<HttpThread, Error>
  readonly getThread: (input: { instance: string; thread: string }) => Effect.Effect<HttpThread | undefined, Error>
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

type PublicHttpError = Readonly<{ code: string; message: string }>

export interface ErrorLogPolicy {
  readonly maxDepth: number
  readonly maxErrors: number
  readonly maxMessageLength: number
}

export const DEFAULT_ERROR_LOG_POLICY: ErrorLogPolicy = Object.freeze({ maxDepth: 4, maxErrors: 32, maxMessageLength: 4096 })

export function errorLogFields(error: unknown, options: Partial<ErrorLogPolicy> = {}): Record<string, Schema.Json> {
  const requested = { ...DEFAULT_ERROR_LOG_POLICY, ...options }
  const rejected = Object.entries(requested).filter(([name, value]) => !Number.isSafeInteger(value) || value < (name === "maxDepth" ? 0 : 1)).map(([name]) => name)
  const policy = rejected.length ? DEFAULT_ERROR_LOG_POLICY : requested
  let truncated = rejected.length > 0
  const text = (value: string) => {
    if (value.length <= policy.maxMessageLength) return value
    truncated = true
    return value.slice(0, policy.maxMessageLength)
  }
  const read = (value: unknown, key: string): unknown => {
    try { return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined }
    catch { truncated = true; return undefined }
  }
  const chain: Array<Record<string, Schema.Json>> = []
  const queue = [{ value: error, depth: 0, path: "error" }]
  const seen = new Set<unknown>()
  const enqueue = (value: unknown, depth: number, path: string) => {
    if (depth > policy.maxDepth || queue.length >= policy.maxErrors) { truncated = true; return }
    queue.push({ value, depth, path })
  }
  for (let index = 0; index < queue.length; index++) {
    const { value, depth, path } = queue[index]!
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) { truncated = true; continue }
      seen.add(value)
    }
    const entry: Record<string, Schema.Json> = { path }
    for (const key of ["name", "message", "code", "stage", "reason"]) {
      const field = read(value, key)
      if (typeof field === "string") entry[key] = text(field)
    }
    if (typeof value === "string") entry.message = text(value)
    const position = read(value, "position")
    if (typeof position === "number" && Number.isSafeInteger(position)) entry.position = position
    chain.push(entry)
    const cause = read(value, "cause")
    if (cause !== undefined) enqueue(cause, depth + 1, `${path}.cause`)
    try {
      const children = read(value, "errors")
      if (Array.isArray(children)) {
        const remaining = policy.maxErrors - queue.length
        const length = children.length
        if (length > remaining) truncated = true
        for (let child = 0; child < Math.min(length, remaining); child++) enqueue(read(children, String(child)), depth + 1, `${path}.errors[${child}]`)
      }
      if (Cause.isCause(value)) {
        const remaining = policy.maxErrors - queue.length
        if (value.reasons.length > remaining) truncated = true
        for (let child = 0; child < Math.min(value.reasons.length, remaining); child++) {
          const reason = value.reasons[child]!
          enqueue(Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : "Interrupted", depth + 1, `${path}.reasons[${child}]`)
        }
      }
    } catch { truncated = true }
  }
  const root = chain[0] ?? {}
  return {
    errorName: root.name ?? "Unknown", errorMessage: root.message ?? "Unknown error", ...(root.code === undefined ? {} : { errorCode: root.code }),
    ...(root.stage === undefined ? {} : { errorStage: root.stage }), ...(root.reason === undefined ? {} : { errorReason: root.reason }),
    ...(root.position === undefined ? {} : { errorPosition: root.position }),
    errorCauses: chain.slice(1), errorDiagnosticsTruncated: truncated, errorLogPolicy: { ...policy }, ...(rejected.length ? { errorLogPolicyRejected: rejected } : {}),
  }
}

export const httpFailure = (error: unknown, policy: Partial<ErrorLogPolicy> = {}) => Effect.gen(function* () {
  const response = publicError(error)
  yield* Effect.logError("HTTP request failed").pipe(Effect.annotateLogs({ ...errorLogFields(error, policy), code: response.body.code, status: response.status }))
  return response
})

// publicError converts internal failures into the stable error contract exposed by HTTP hosts.
export const publicError = (error: unknown): Readonly<{ status: number; body: PublicHttpError }> => {
  if (error instanceof ActorReplayError) return { status: 500, body: { code: "actor_replay_failed", message: "Actor history could not be replayed" } }
  if (error instanceof HttpError) return { status: error.status, body: { code: error.code, message: error.message } }
  if (error instanceof WatchdogTerminalError) return { status: 500, body: { code: "actor_boot_failed", message: error.message || "Actor failed during startup" } }
  if (error instanceof ActorCommitError) return { status: 500, body: { code: "actor_commit_failed", message: error.message } }
  if (error instanceof InvocationNotFound) return { status: 404, body: { code: "call_not_found", message: error.message } }
  if (error instanceof InvalidMessage) return { status: 400, body: { code: "invalid_message", message: error.message } }
  if (error instanceof StateInitialisationError) return { status: 400, body: { code: "invalid_initial_state", message: error.message } }
  if (error instanceof MessageConflict) return { status: 409, body: { code: "message_conflict", message: "Message conflicts with an existing idempotency key" } }
  return { status: 500, body: { code: "internal_error", message: "Internal server error" } }
}

const AllocationInput = Schema.Struct({ name: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isPattern(/^[^/]+$/))), parent: Schema.optionalKey(Schema.NonEmptyString), initialState: Schema.optionalKey(InitialState) })
const base = "/v1/actors/:instance/threads"

// hostRoutes exposes thread allocation, message submission, acceptance receipts, and live execution updates.
export function hostRoutes(host: HttpHost, errorLog: Partial<ErrorLogPolicy> = {}) {
  const respond = <Error, Services>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Error, Services>) => handler.pipe(
    Effect.catch(error => Effect.gen(function* () {
      const response = yield* httpFailure(error, errorLog)
      return HttpServerResponse.jsonUnsafe(response.body, { status: response.status })
    })),
  )
  return Layer.mergeAll(
    HttpRouter.add("GET", `${base}/:thread/execution/stream`, respond(Effect.gen(function* () {
      const { instance, thread } = yield* HttpRouter.params
      if (!host.execution) return yield* Effect.fail(new HttpError(404, "execution_stream_unavailable", "Execution stream unavailable"))
      if (!(yield* host.getThread({ instance: instance!, thread: thread! }))) return yield* Effect.fail(new HttpError(404, "thread_not_found", "Unknown thread"))
      return executionStreamSse(host.execution.stream, { actor: host.actor, instance: instance!, thread: thread! })
    }))),
    HttpRouter.add("POST", base, respond(Effect.gen(function* () {
      const { instance } = yield* HttpRouter.params
      const input = yield* HttpServerRequest.schemaBodyJson(AllocationInput, { onExcessProperty: "error" }).pipe(Effect.mapError(() => new HttpError(400, "invalid_allocation", "Expected { name?: string, parent?: string, initialState?: Record<string, JSON> }")))
      if (input.parent !== undefined && ! (yield* host.getThread({ instance: instance!, thread: input.parent! }))) return yield* Effect.fail(new HttpError(404, "parent_thread_not_found", "Unknown parent thread"))
      const allocation = { ...(input.name === undefined ? {} : { name: input.name }), ...(input.initialState === undefined ? {} : { initialState: input.initialState }) }
      const thread = yield* (input.parent === undefined
        ? host.allocateRootThread({ instance: instance!, ...allocation })
        : host.allocateChildThread({ parent: { actor: host.actor, instance: instance!, thread: input.parent }, ...allocation }))
      return HttpServerResponse.jsonUnsafe(thread.coordinate, { status: 200 })
    }))),
    HttpRouter.add("POST", `${base}/:thread/messages`, request => respond(Effect.gen(function* () {
      const { instance, thread } = yield* HttpRouter.params
      const id = request.headers["idempotency-key"]
      if (!id?.trim()) return yield* Effect.fail(new HttpError(400, "missing_idempotency_key", "Idempotency-Key is required"))
      const body = yield* HttpServerRequest.schemaBodyJson(Schema.Struct({ body: Schema.Json, inReplyTo: Schema.optionalKey(Schema.NonEmptyString) }), { onExcessProperty: "error" }).pipe(Effect.mapError(() => new HttpError(400, "invalid_message", "Expected { body, inReplyTo?: string }")))
      if (!(yield* host.getThread({ instance: instance!, thread: thread! }))) return yield* Effect.fail(new HttpError(404, "thread_not_found", "Unknown thread"))
      const receipt = yield* host.send({ id, target: { actor: host.actor, instance: instance!, thread: thread! }, ...body })
      const location = `/v1/actors/${encodeURIComponent(instance!)}/threads/${encodeURIComponent(thread!)}/messages/${encodeURIComponent(id)}`
      return HttpServerResponse.jsonUnsafe(receipt, { status: 202, headers: { location } })
    }))),
    HttpRouter.add("GET", `${base}/:thread/messages/:id`, respond(Effect.gen(function* () {
      const { instance, thread: name, id } = yield* HttpRouter.params
      const thread = yield* host.getThread({ instance: instance!, thread: name! })
      const receipt = thread ? yield* thread.receipt(id!) : undefined
      if (!receipt) return yield* Effect.fail(new HttpError(404, "message_not_found", "Unknown message"))
      return HttpServerResponse.jsonUnsafe(receipt)
    }))),
  )
}
