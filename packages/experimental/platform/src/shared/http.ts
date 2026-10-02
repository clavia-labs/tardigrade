import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { InitialState, StateInitialisationError, InvalidMessage, MessageConflict, type MessageReceipt } from "@clavia/tardigrade-experimental-core"
import type { MessageDelivery } from "@clavia/tardigrade-experimental-core"
import type { ThreadRequest, ThreadCoordinate } from "@clavia/tardigrade-experimental-core"

interface HttpThread {
  readonly coordinate: ThreadCoordinate
  readonly receipt: (id: string) => Effect.Effect<MessageReceipt | undefined, Error>
}
export interface HttpHost {
  readonly actor: string
  readonly send: (message: MessageDelivery) => Effect.Effect<MessageReceipt, Error>
  readonly allocateRootThread: (input: Omit<ThreadRequest, "parent" | "placement">) => Effect.Effect<HttpThread, Error>
  readonly allocateChildThread: (input: Omit<ThreadRequest, "instance" | "parent" | "placement"> & { readonly parent: ThreadCoordinate }) => Effect.Effect<HttpThread, Error>
  readonly getThread: (input: { instance: string; thread: string }) => Effect.Effect<HttpThread | undefined, Error>
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const respond = <Error, Services>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Error, Services>) => handler.pipe(
  Effect.catch(error => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error instanceof Error ? error.message : String(error) }, {
    status: error instanceof HttpError ? error.status : error instanceof InvalidMessage || error instanceof StateInitialisationError ? 400 : error instanceof MessageConflict ? 409 : 500,
  }))),
)
const AllocationInput = Schema.Struct({ name: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isPattern(/^[^/]+$/))), parent: Schema.optionalKey(Schema.NonEmptyString), initialState: Schema.optionalKey(InitialState) })
const base = "/v1/actors/:instance/threads"

// hostRoutes exposes thread allocation, message submission, and acceptance receipts.
export function hostRoutes(host: HttpHost) {
  return Layer.mergeAll(
    HttpRouter.add("POST", base, respond(Effect.gen(function* () {
      const { instance } = yield* HttpRouter.params
      const input = yield* HttpServerRequest.schemaBodyJson(AllocationInput, { onExcessProperty: "error" }).pipe(Effect.mapError(() => new HttpError(400, "Expected { name?: string, parent?: string, initialState?: Record<string, JSON> }")))
      if (input.parent !== undefined && ! (yield* host.getThread({ instance: instance!, thread: input.parent! }))) return yield* Effect.fail(new HttpError(404, "Unknown parent thread"))
      const allocation = { ...(input.name === undefined ? {} : { name: input.name }), ...(input.initialState === undefined ? {} : { initialState: input.initialState }) }
      const thread = yield* (input.parent === undefined
        ? host.allocateRootThread({ instance: instance!, ...allocation })
        : host.allocateChildThread({ parent: { actor: host.actor, instance: instance!, thread: input.parent }, ...allocation }))
      return HttpServerResponse.jsonUnsafe(thread.coordinate, { status: 200 })
    }))),
    HttpRouter.add("POST", `${base}/:thread/messages`, request => respond(Effect.gen(function* () {
      const { instance, thread } = yield* HttpRouter.params
      const id = request.headers["idempotency-key"]
      if (!id?.trim()) return yield* Effect.fail(new HttpError(400, "Idempotency-Key is required"))
      const body = yield* HttpServerRequest.schemaBodyJson(Schema.Struct({ body: Schema.Json, inReplyTo: Schema.optionalKey(Schema.NonEmptyString) }), { onExcessProperty: "error" }).pipe(Effect.mapError(() => new HttpError(400, "Expected { body, inReplyTo?: string }")))
      if (!(yield* host.getThread({ instance: instance!, thread: thread! }))) return yield* Effect.fail(new HttpError(404, "Unknown thread"))
      const receipt = yield* host.send({ id, target: { actor: host.actor, instance: instance!, thread: thread! }, ...body })
      const location = `/v1/actors/${encodeURIComponent(instance!)}/threads/${encodeURIComponent(thread!)}/messages/${encodeURIComponent(id)}`
      return HttpServerResponse.jsonUnsafe(receipt, { status: 202, headers: { location } })
    }))),
    HttpRouter.add("GET", `${base}/:thread/messages/:id`, respond(Effect.gen(function* () {
      const { instance, thread: name, id } = yield* HttpRouter.params
      const thread = yield* host.getThread({ instance: instance!, thread: name! })
      const receipt = thread ? yield* thread.receipt(id!) : undefined
      if (!receipt) return yield* Effect.fail(new HttpError(404, "Unknown message"))
      return HttpServerResponse.jsonUnsafe(receipt)
    }))),
  )
}
