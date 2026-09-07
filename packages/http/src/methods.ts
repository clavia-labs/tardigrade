import { Clock, Context, Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import { threadCreatedOf } from "@clavia/tardigrade-core/interaction/relations"
import { invocationCoordinateOf } from "@clavia/tardigrade-core/interaction"
import { methodRequestLocation, existingMethodRequest, prepareMethodRequest, methodRequestState, methodCancellationRequest, methodCancellationEvent } from "./method-request"
import { InvalidRequest, InvocationSettled, RESERVED_ACTOR, UnknownMethod, UnknownMethodCall, UnknownActor, UnknownThread, methodsGroup, RequestProblems } from "@clavia/tardigrade-client/contract"

export interface MethodThreads {
  readonly methods: ActorMethods
  readonly events: (thread: string) => Effect.Effect<ReadonlyArray<Event>>
  readonly append: (thread: string, event: Event) => Effect.Effect<void, typeof UnknownThread.schema.Type>
}

// MethodRuntime supplies method declarations and durable logs to HTTP handlers.
export class MethodRuntime extends Context.Service<MethodRuntime, {
  readonly actorName?: string
  readonly methods: ActorMethods
  readonly instance: (id: string) => Effect.Effect<MethodThreads | undefined>
}>()("tardigrade/http/MethodRuntime") {}

export const MethodApi = HttpApi.make("tardigrade").add(methodsGroup).middleware(RequestProblems)

const actorOf = (runtime: typeof MethodRuntime.Service, id: string) =>
  Effect.flatMap(runtime.instance(id), (actor) => actor === undefined
    ? Effect.fail(UnknownActor.of(`No actor instance named ${JSON.stringify(id)} has ever existed.`))
    : Effect.succeed(actor))

const unknownThreadDetail = (id: string) => `No thread named ${JSON.stringify(id)} has ever existed.`
const failureMessage = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure)

const unknownMethodDetail = (name: string, methods: Readonly<Record<string, unknown>>): string => {
  const declared = Object.keys(methods)
  const available = declared.length === 0
    ? "This actor declares no methods."
    : `This actor declares ${declared.map((method) => JSON.stringify(method)).join(", ")}.`
  return `No method named ${JSON.stringify(name)} is declared. ${available}`
}

const logOf = (read: (id: string) => Effect.Effect<ReadonlyArray<Event>>, id: string) =>
  Effect.flatMap(read(id), (log) =>
    log.length === 0 ? Effect.fail(UnknownThread.of(unknownThreadDetail(id))) : Effect.succeed(log))

// jsonSchemaOf attaches every generated definition to the root schema that references it.
const jsonSchemaOf = (schema: Schema.Constraint): unknown => {
  const document = Schema.toJsonSchemaDocument(schema)
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions }
}

const methodOf = (threads: MethodThreads, name: string) => {
  const method = threads.methods[name]
  return method === undefined
    ? Effect.fail(UnknownMethod.of(unknownMethodDetail(name, threads.methods)))
    : Effect.succeed(method)
}

const invokeMethod = <R>(
  runtime: Effect.Effect<typeof MethodRuntime.Service, never, R>,
  params: { readonly id: string; readonly thread: string; readonly method: string; readonly call: string },
  query: { readonly actor?: string; readonly timeoutMs?: number },
  payload: unknown
) =>
  Effect.gen(function*() {
    const service = yield* runtime
    if (query.actor !== undefined && query.actor !== (service.actorName ?? RESERVED_ACTOR)) return yield* Effect.fail(InvalidRequest.of("Invocation target actor does not match this deployment."))
    const threads = yield* actorOf(service, params.id)
    const method = yield* methodOf(threads, params.method)
    const events = yield* logOf(threads.events, params.thread)
    const reference = invocationCoordinateOf(
      threadCreatedOf(events)?.address ?? { actor: service.actorName ?? RESERVED_ACTOR, instance: params.id, thread: params.thread },
      { method: params.method, id: params.call, epoch: 0 }
    )
    const existing = existingMethodRequest(events, reference)
    if (existing !== undefined) return existing
    const at = yield* Clock.currentTimeMillis
    const prepared = yield* Effect.try({
      try: () => prepareMethodRequest({ reference, method, input: payload, at,
        ...(query.timeoutMs === undefined ? {} : { timeoutMs: query.timeoutMs }) }),
      catch: (failure) => InvalidRequest.of(failureMessage(failure))
    })
    yield* threads.append(params.thread, prepared.event)
    return prepared.accepted
  })

// methodHandlers invokes and reads the method declarations carried by the mounted actor runtime.
export const methodHandlers = <R>(runtime: Effect.Effect<typeof MethodRuntime.Service, never, R>) => HttpApiBuilder.group(MethodApi, "methods", (handlers) =>
  handlers
    .handle("methods", () =>
      Effect.map(runtime, (threads) =>
        Object.entries(threads.methods).map(([name, method]) => ({
          name,
          cancellable: method.cancellation !== undefined,
          timeoutMs: method.timeoutMs,
          inputSchema: jsonSchemaOf(method.input),
          outputSchema: jsonSchemaOf(method.output)
        }))))
    .handle("invoke", ({ params, query, payload }) => Effect.map(invokeMethod(runtime, params, query, payload), (receipt) =>
      HttpServerResponse.jsonUnsafe(receipt, { status: 202, headers: { location: methodRequestLocation(receipt.reference) } })))
    .handle("invokeMethod", ({ params, query, payload, headers }) => Effect.gen(function* () {
      const call = headers["idempotency-key"]
      if (!call.trim()) return yield* Effect.fail(InvalidRequest.of("Idempotency-Key must be a nonempty header"))
      const receipt = yield* invokeMethod(runtime, { ...params, call }, query, payload)
      return HttpServerResponse.jsonUnsafe(receipt, { status: 202, headers: { location: methodRequestLocation(receipt.reference) } })
    }))
    .handle("methodState", ({ params, query }) =>
      Effect.gen(function*() {
        const service = yield* runtime
        if (query.actor !== undefined && query.actor !== (service.actorName ?? RESERVED_ACTOR)) {
          return yield* Effect.fail(InvalidRequest.of("Invocation target actor does not match this deployment."))
        }
        const threads = yield* actorOf(service, params.id)
        const method = yield* methodOf(threads, params.method)
        const log = yield* logOf(threads.events, params.thread)
        const { state } = methodRequestState(log, method, { method: params.method, id: params.call, ...(query.epoch === undefined ? {} : { epoch: query.epoch }) })
        if (state === undefined) {
          return yield* Effect.fail(
            UnknownMethodCall.of(
              `No call named ${JSON.stringify(params.call)} exists for method ${JSON.stringify(params.method)} on this thread.`
            )
          )
        }
        return state
      }))
    .handle("cancel", ({ params, query, payload }) =>
      Effect.gen(function*() {
        const service = yield* runtime
        if (query.actor !== undefined && query.actor !== (service.actorName ?? RESERVED_ACTOR)) {
          return yield* Effect.fail(InvalidRequest.of("Invocation target actor does not match this deployment."))
        }
        const threads = yield* actorOf(service, params.id)
        const method = yield* methodOf(threads, params.method)
        const log = yield* logOf(threads.events, params.thread)
        const { invocation, status: disposition } = methodCancellationRequest(log, method, { method: params.method, id: params.call, ...(query.epoch === undefined ? {} : { epoch: query.epoch }) })
        if (disposition === "unknown") {
          return yield* Effect.fail(UnknownMethodCall.of(
            `No call named ${JSON.stringify(params.call)} exists for method ${JSON.stringify(params.method)} on this thread.`
          ))
        }
        if (disposition === "unsupported") {
          return yield* Effect.fail(InvalidRequest.of(
            `Method ${JSON.stringify(params.method)} does not declare cancellation.`
          ))
        }
        if (disposition === "settled") {
          return yield* Effect.fail(InvocationSettled.of(
            `Invocation ${JSON.stringify(params.call)} has settled and cannot be cancelled.`
          ))
        }
        if (disposition !== "requestable") {
          return {
            actor: params.id,
            thread: params.thread,
            method: params.method,
            call: params.call,
            status: disposition
          }
        }
        const at = yield* Clock.currentTimeMillis
        yield* threads.append(params.thread, methodCancellationEvent(invocation, at, payload.reason))
        return {
          actor: params.id,
          thread: params.thread,
          method: params.method,
          call: params.call,
          status: "requested" as const
        }
      })))

export const layerMethodHandlers = methodHandlers(MethodRuntime)
