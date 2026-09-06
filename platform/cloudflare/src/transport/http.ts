import { Clock, Context, Effect, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { CATALOG_AVAILABILITY_FILTERS, MODEL_CATALOG_PRICE_SORTS, MODEL_CATALOG_SORT_ORDERS, MODEL_CATALOG_UNPRICED_ORDERS, InvocationSettled } from "@clavia/tardigrade-client/contract"
import type { ActorMethods, ModelPolicy } from "tardie"
import type { ModelCatalogState } from "@clavia/tardigrade-server/catalog"
import type { providerAvailabilitiesOf } from "@clavia/tardigrade-server/catalog-availability"
import { modelsPageOf, providersPageOf } from "@clavia/tardigrade-server/catalog-page"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { ActorInstanceId } from "@clavia/tardigrade-core/transport/endpoint"
import { invocationCoordinateOf } from "@clavia/tardigrade-core/interaction"
import { existingMethodRequest, prepareMethodRequest, methodRequestState, methodCancellationRequest, methodCancellationEvent } from "@clavia/tardigrade-host/transport/http/method-request"
import type { Env } from "../env"
import type { CloudflareDirectory } from "./directory"

export const DEFAULT_CLOUDFLARE_EVENT_LIMIT = 200

interface CloudflareHttpOptions {
  readonly actorName: () => string
  readonly methodsOf: (name: string) => ActorMethods | undefined
  readonly publicCatalog: (env: Env) => Promise<ModelCatalogState>
  readonly providerAvailabilityFrom: (env: Env) => ReturnType<typeof providerAvailabilitiesOf>
  readonly modelPolicyFrom: (env: Env) => ModelPolicy
  readonly directory: CloudflareDirectory
}

// cloudflareHttp adapts HTTP requests to the mounted host's methods and directory.
export const cloudflareHttp = ({
  actorName, methodsOf, publicCatalog, providerAvailabilityFrom, modelPolicyFrom, directory
}: CloudflareHttpOptions): ExportedHandler<Env> => {
  const { actorStub, threadStub } = directory
  class WorkerEnv extends Context.Service<WorkerEnv, Env>()("tardigrade/cloudflare/WorkerEnv") {}

  const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })

  const jsonSchemaOf = (schema: Schema.Constraint): unknown => {
    const document = Schema.toJsonSchemaDocument(schema)
    return Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions }
  }

  const invocationQueryOf = (request: HttpServerRequest.HttpServerRequest): { readonly epoch?: number } | { readonly error: string } => {
    const actor = new URL(request.url, "http://worker").searchParams.get("actor")
    if (actor !== null && actor !== actorName()) return { error: "Invocation target actor does not match this deployment." }
    const raw = new URL(request.url, "http://worker").searchParams.get("epoch")
    if (raw === null) return {}
    const epoch = Number(raw)
    return raw.trim() !== "" && Number.isSafeInteger(epoch) && epoch >= 0 ? { epoch } : { error: "epoch must be a non-negative safe integer" }
  }

  const authorized = (request: HttpServerRequest.HttpServerRequest, env: Env): boolean =>
    env.TARDIGRADE_TOKEN !== undefined && request.headers.authorization === `Bearer ${env.TARDIGRADE_TOKEN}`

  const guard = (request: HttpServerRequest.HttpServerRequest, env: Env) => {
    if (env.TARDIGRADE_TOKEN === undefined) return json({ error: "authentication is not configured" }, 503)
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401)
    return undefined
  }

  const catalogQueryOf = (request: HttpServerRequest.HttpServerRequest) => {
    const query = new URL(request.url, "http://worker").searchParams
    const value = (name: string): string | undefined => query.get(name) ?? undefined
    const limit = value("limit")
    return {
      availability: catalogChoiceOf(query.get("availability"), "availability", CATALOG_AVAILABILITY_FILTERS),
      cursor: value("cursor"),
      search: value("search"),
      ...(limit === undefined ? {} : { limit: Number(limit) })
    }
  }

  const catalogChoiceOf = <const Values extends ReadonlyArray<string>>(
    raw: string | null,
    name: string,
    values: Values
  ): Values[number] | undefined => {
    if (raw === null) return undefined
    if (values.includes(raw)) return raw as Values[number]
    throw new Error(`catalog ${name} must be one of ${values.join(", ")}`)
  }

  const protectedRoute = <E, R>(
    f: (
      request: HttpServerRequest.HttpServerRequest,
      env: Env
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ) => Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const env = yield* WorkerEnv
    const refused = guard(request, env)
    return refused ?? (yield* f(request, env))
  })

  const routes = [
    HttpRouter.route("GET", "/healthz", Effect.gen(function* () {
      return json({ status: "ready", actor: actorName() })
    })),
    HttpRouter.route("GET", "/v1/providers", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const env = yield* WorkerEnv
      return yield* Effect.tryPromise({
        try: async () => {
          const catalog = await publicCatalog(env)
          if (catalog.snapshot === undefined) {
            throw new Error(catalog.refreshError ?? catalog.cacheError ?? "no validated model catalog is available")
          }
          return providersPageOf(catalog.snapshot, providerAvailabilityFrom(env), {
            ...catalogQueryOf(request),
            policy: modelPolicyFrom(env)
          })
        },
        catch: (cause) => cause instanceof Error ? cause.message : String(cause)
      }).pipe(Effect.match({
        onFailure: (error) => json({ error }, error.includes("catalog cursor") || error.includes("catalog limit") ? 400 : 503),
        onSuccess: (page) => json(page)
      }))
    })),
    HttpRouter.route("GET", "/v1/models", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const env = yield* WorkerEnv
      return yield* Effect.tryPromise({
        try: async () => {
          const catalog = await publicCatalog(env)
          if (catalog.snapshot === undefined) {
            throw new Error(catalog.refreshError ?? catalog.cacheError ?? "no validated model catalog is available")
          }
          const query = new URL(request.url, "http://worker").searchParams
          return modelsPageOf(catalog.snapshot, providerAvailabilityFrom(env), {
            ...catalogQueryOf(request),
            policy: modelPolicyFrom(env),
            provider: query.get("provider") ?? undefined,
            sort: catalogChoiceOf(query.get("sort"), "sort", MODEL_CATALOG_PRICE_SORTS),
            order: catalogChoiceOf(query.get("order"), "order", MODEL_CATALOG_SORT_ORDERS),
            unpriced: catalogChoiceOf(query.get("unpriced"), "unpriced", MODEL_CATALOG_UNPRICED_ORDERS)
          })
        },
        catch: (cause) => cause instanceof Error ? cause.message : String(cause)
      }).pipe(Effect.match({
        onFailure: (error) => json({ error }, error.startsWith("catalog ") ? 400 : 503),
        onSuccess: (page) => json(page)
      }))
    })),
    HttpRouter.route("GET", "/v1/metadata", protectedRoute((_request, _env) =>
      Effect.succeed(json({ name: actorName(), storage: { kind: "durable-object" } }))
    )),
    HttpRouter.route("GET", "/v1/methods", protectedRoute((_request, _env) =>
      Effect.gen(function* () {
        const methods = methodsOf(actorName())
        if (methods === undefined) return json({ error: "actor assembly is not deployed" }, 503)
        return json(Object.entries(methods).map(([name, method]) => ({
          name,
          cancellable: method.cancellation !== undefined,
          timeoutMs: method.timeoutMs,
          inputSchema: jsonSchemaOf(method.input),
          outputSchema: jsonSchemaOf(method.output)
        })))
      })
    )),
    HttpRouter.route("PUT", "/v1/actors/:id", protectedRoute((_request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const stub = yield* Effect.promise(() => actorStub(env, actorName(), instance, true))
        if (stub === undefined) return json({ error: "actor is not deployed" }, 503)
        return json({ actor: instance, definition: actorName() })
      })
    )),
    HttpRouter.route("GET", "/v1/actors/:id", protectedRoute((_request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const stub = yield* Effect.promise(() => actorStub(env, actorName(), instance, false))
        return stub === undefined
          ? json({ error: "unknown actor" }, 404)
          : json({ actor: instance, definition: actorName() })
      })
    )),
    HttpRouter.route("POST", "/v1/actors/:id/threads", protectedRoute((request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const payload = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (!Schema.is(Schema.Struct({ name: Schema.optionalKey(Schema.NonEmptyString) }))(payload)) return json({ error: "name must be a nonempty string when supplied" }, 400)
        const directory = yield* Effect.promise(() => actorStub(env, actorName(), instance, true))
        if (directory === undefined) return json({ error: "unknown actor" }, 404)
        const coordinate = yield* Effect.promise(() => directory.createThread(payload.name))
        return json(coordinate)
      })
    )),
    HttpRouter.route("PUT", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call", protectedRoute((request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const actor = actorName()
        const instance = params.id ?? ""
        const thread = params.thread ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const methodName = params.method ?? ""
        const call = params.call ?? ""
        const method = methodsOf(actor)?.[methodName]
        if (method === undefined) return json({ error: "unknown method" }, 404)
        const stub = yield* Effect.promise(() => threadStub(env, actor, instance, thread))
        if (stub === undefined) return json({ error: "unknown thread" }, 404)
        const events = yield* Effect.promise(() => stub.stub.events(stub.thread)).pipe(
          Effect.map((value) => value as ReadonlyArray<Event>)
        )
        const reference = invocationCoordinateOf(
          { actor, instance, thread: stub.thread },
          { method: methodName, id: call, epoch: 0 }
        )
        const existing = existingMethodRequest(events, reference)
        if (existing !== undefined) return json(existing, 202)
        const requestedTimeout = new URL(request.url, "http://worker").searchParams.get("timeoutMs")
        const input = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        const at = yield* Clock.currentTimeMillis
        const prepared = yield* Effect.try({
          try: () => prepareMethodRequest({ reference, method, input, at,
            ...(requestedTimeout === null ? {} : { timeoutMs: Number(requestedTimeout) }) }),
          catch: (failure) => failure instanceof Error ? failure.message : String(failure)
        }).pipe(Effect.result)
        if (prepared._tag === "Failure") return json({ error: prepared.failure }, 400)
        const appended = yield* Effect.promise(() => stub.stub.append(stub.thread, prepared.success.event))
        if (!appended) return json({ error: "unknown thread" }, 404)
        return json(prepared.success.accepted, 202)
      })
    )),
    HttpRouter.route("GET", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call", protectedRoute((request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const actor = actorName()
        const instance = params.id ?? ""
        const thread = params.thread ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const methodName = params.method ?? ""
        const call = params.call ?? ""
        const method = methodsOf(actor)?.[methodName]
        if (method === undefined) return json({ error: "unknown method" }, 404)
        const stub = yield* Effect.promise(() => threadStub(env, actor, instance, thread))
        if (stub === undefined) return json({ error: "unknown thread" }, 404)
        const events = yield* Effect.promise(() => stub.stub.events(stub.thread)).pipe(
          Effect.map((value) => value as ReadonlyArray<Event>)
        )
        const selectedEpoch = invocationQueryOf(request)
        if ("error" in selectedEpoch) return json({ error: selectedEpoch.error }, 400)
        const { state } = methodRequestState(events, method, { method: methodName, id: call, ...(selectedEpoch.epoch === undefined ? {} : { epoch: selectedEpoch.epoch }) })
        return state === undefined ? json({ error: "unknown method call" }, 404) : json(state)
      })
    )),
    HttpRouter.route("PUT", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call/cancellation", protectedRoute((request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const actor = actorName()
        const instance = params.id ?? ""
        const thread = params.thread ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const methodName = params.method ?? ""
        const call = params.call ?? ""
        const method = methodsOf(actor)?.[methodName]
        if (method === undefined) return json({ error: "unknown method" }, 404)
        const stub = yield* Effect.promise(() => threadStub(env, actor, instance, thread))
        if (stub === undefined) return json({ error: "unknown thread" }, 404)
        const events = yield* Effect.promise(() => stub.stub.events(stub.thread)).pipe(
          Effect.map((value) => value as ReadonlyArray<Event>)
        )
        const selectedEpoch = invocationQueryOf(request)
        if ("error" in selectedEpoch) return json({ error: selectedEpoch.error }, 400)
        const { invocation, status: disposition } = methodCancellationRequest(events, method, { method: methodName, id: call, ...(selectedEpoch.epoch === undefined ? {} : { epoch: selectedEpoch.epoch }) })
        if (disposition === "unknown") return json({ error: "unknown method call" }, 404)
        if (disposition === "unsupported") return json({ error: "method does not declare cancellation" }, 400)
        if (disposition === "settled") {
          return json(InvocationSettled.of(`Invocation ${JSON.stringify(call)} has settled and cannot be cancelled.`), 409)
        }
        if (disposition !== "requestable") {
          return json({ actor: instance, thread, method: methodName, call, status: disposition },
            disposition === "cancelled" ? 200 : 202)
        }
        const payload = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as { readonly reason?: unknown }
        if (payload.reason !== undefined && typeof payload.reason !== "string") return json({ error: "reason must be a string" }, 400)
        const at = yield* Clock.currentTimeMillis
        const appended = yield* Effect.promise(() => stub.stub.append(stub.thread,
          methodCancellationEvent(invocation, at, typeof payload.reason === "string" ? payload.reason : undefined)))
        if (!appended) return json({ error: "unknown thread" }, 404)
        return json({ actor: instance, thread, method: methodName, call, status: "requested" }, 202)
      })
    )),
    HttpRouter.route("GET", "/v1/actors/:id/threads", protectedRoute((_request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const stub = yield* Effect.promise(() => actorStub(env, actorName(), instance, false))
        if (stub === undefined) return json({ error: "unknown actor" }, 404)
        return json(yield* Effect.promise(() => stub.threadTree()))
      })
    )),
    HttpRouter.route("POST", "/v1/actors/:id/threads/:thread/events", protectedRoute((request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const actor = actorName()
        const instance = params.id ?? ""
        const thread = params.thread ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const stub = yield* Effect.promise(() => threadStub(env, actor, instance, thread))
        if (stub === undefined) return json({ error: "unknown thread" }, 404)
        const event = (yield* request.json.pipe(Effect.orElseSucceed(() => undefined))) as Event | undefined
        if (typeof event !== "object" || event === null || typeof event.type !== "string" || event.type === "") {
          return json({ error: "event type is required" }, 400)
        }
        const appended = yield* Effect.promise(() => stub.stub.append(stub.thread, event))
        if (!appended) return json({ error: "unknown thread" }, 404)
        return json({ actor: instance, thread }, 202)
      })
    )),
    HttpRouter.route("GET", "/v1/actors/:id/threads/:thread/events", protectedRoute((request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const actor = actorName()
        const instance = params.id ?? ""
        const thread = params.thread ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const stub = yield* Effect.promise(() => threadStub(env, actor, instance, thread))
        if (stub === undefined) return json({ error: "unknown thread" }, 404)
        const url = new URL(request.url, "http://worker")
        const after = Number(url.searchParams.get("after") ?? 0)
        const limit = Number(url.searchParams.get("limit") ?? DEFAULT_CLOUDFLARE_EVENT_LIMIT)
        if (!Number.isSafeInteger(after) || after < 0) return json({ error: "after must be a non-negative integer" }, 400)
        if (!Number.isSafeInteger(limit) || limit < 0) return json({ error: "limit must be a non-negative integer" }, 400)
        const types = url.searchParams.get("types")?.split(",").map((type) => type.trim()).filter((type) => type.length > 0)
        return yield* Effect.tryPromise({
          try: () => stub.stub.queryEvents(stub.thread, { after, limit, ...(types === undefined ? {} : { types }) }),
          catch: (cause) => cause instanceof Error ? cause.message : String(cause)
        }).pipe(Effect.match({
          onFailure: (error) => json({ error }, 500),
          onSuccess: (rows) => json(rows)
        }))
      })
    )),
    HttpRouter.route("*", "/*", json({ error: "not found" }, 404))
  ] as const

  const router = Effect.runSync(HttpRouter.make)
  // routes carry request requirements as registration markers; addAll records them without running a handler (effect/unstable/http/HttpRouter.ts, addAll).
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
  Effect.runSync(router.addAll(routes) as Effect.Effect<void>)
  // httpApp handles the router's opaque internal failure at the web boundary.
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  const httpApp = router.asHttpEffect().pipe(Effect.orElseSucceed(() => json({ error: "internal server error" }, 500)))
  const webHandler = HttpEffect.toWebHandler(httpApp)

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      return webHandler(request, Context.make(WorkerEnv, env) as Context.Context<never>)
    }
  } satisfies ExportedHandler<Env>

}
