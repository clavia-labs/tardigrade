import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { InvocationConflict, type InvocationReceipt } from "./invocation"
import type { ThreadCoordinate } from "./contracts"

interface HttpThread {
  readonly coordinate: ThreadCoordinate
  readonly methods: Readonly<Record<string, (...args: never[]) => Effect.Effect<InvocationReceipt, Error>>>
  readonly invocation: (key: string) => InvocationReceipt | undefined
}
export interface HttpHost {
  readonly actor: string
  readonly allocateRootThread: (input: { instance: string; name?: string }) => Effect.Effect<HttpThread, Error>
  readonly allocateChildThread: (input: { parent: ThreadCoordinate; name?: string }) => Effect.Effect<HttpThread, Error>
  readonly getThread: (input: { instance: string; thread: string }) => Effect.Effect<HttpThread | undefined, Error>
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const respond = <Error, Services>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Error, Services>) => handler.pipe(
  Effect.catch(error => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error instanceof Error ? error.message : String(error) }, {
    status: error instanceof HttpError ? error.status : error instanceof InvocationConflict ? 409 : 500,
  }))),
)
const AllocationInput = Schema.Struct({ name: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isPattern(/^[^/]+$/))), parent: Schema.optionalKey(Schema.NonEmptyString) })
const base = "/v1/actors/:instance/threads"

// hostRoutes exposes thread allocation, method invocation, and invocation receipts.
export function hostRoutes(host: HttpHost) {
  return Layer.mergeAll(
    HttpRouter.add("POST", base, respond(Effect.gen(function* () {
      const { instance } = yield* HttpRouter.params
      const input = yield* HttpServerRequest.schemaBodyJson(AllocationInput, { onExcessProperty: "error" }).pipe(Effect.mapError(() => new HttpError(400, "Expected { name?: string, parent?: string }")))
      if (input.parent !== undefined && ! (yield* host.getThread({ instance: instance!, thread: input.parent! }))) return yield* Effect.fail(new HttpError(404, "Unknown parent thread"))
      const name = input.name === undefined ? {} : { name: input.name }
      const thread = yield* (input.parent === undefined
        ? host.allocateRootThread({ instance: instance!, ...name })
        : host.allocateChildThread({ parent: { actor: host.actor, instance: instance!, thread: input.parent }, ...name }))
      return HttpServerResponse.jsonUnsafe(thread.coordinate, { status: 200 })
    }))),
    HttpRouter.add("POST", `${base}/:thread/methods/:method`, request => respond(Effect.gen(function* () {
      const { instance, thread: id, method } = yield* HttpRouter.params
      const key = request.headers["idempotency-key"]
      if (!key?.trim()) return yield* Effect.fail(new HttpError(400, "Idempotency-Key is required"))
      const input = yield* request.json.pipe(Effect.mapError(() => new HttpError(400, "Invalid JSON body")))
      const thread = yield* host.getThread({ instance: instance!, thread: id! })
      if (!thread || !Object.hasOwn(thread.methods, method!)) return yield* Effect.fail(new HttpError(404, "Unknown thread or method"))
      const receipt = yield* thread.methods[method!]!(...([input, { key }] as never[]))
      const location = `/v1/actors/${encodeURIComponent(instance!)}/threads/${encodeURIComponent(id!)}/invocations/${encodeURIComponent(key)}`
      return HttpServerResponse.jsonUnsafe(receipt, { status: 202, headers: { location } })
    }))),
    HttpRouter.add("GET", `${base}/:thread/invocations/:key`, respond(Effect.gen(function* () {
      const { instance, thread: id, key } = yield* HttpRouter.params
      const thread = yield* host.getThread({ instance: instance!, thread: id! })
      const receipt = thread?.invocation(key!)
      if (!receipt) return yield* Effect.fail(new HttpError(404, "Unknown invocation"))
      return HttpServerResponse.jsonUnsafe(receipt)
    }))),
  )
}
