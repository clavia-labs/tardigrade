import { Context, Effect, Layer, Schema } from "effect"
import { HttpServer, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { FactsRequest, UnknownThread, type TreeBounds } from "@clavia/tardigrade-client/contract"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import type { ModelPolicy } from "@clavia/tardigrade-agent"
import type { ModelCatalogState } from "@clavia/tardigrade-model/catalog"
import type { providerAvailabilitiesOf } from "@clavia/tardigrade-model/catalog-availability"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { MAX_SUBJECT_LENGTH, MAX_SUBJECTS_PER_LOOKUP } from "@clavia/tardigrade-core/log/subjects"
import { ActorInstanceId } from "@clavia/tardigrade-core/transport/endpoint"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MethodApi, MethodRuntime, layerMethodHandlers } from "@clavia/tardigrade-http/methods"
import { CatalogApi, CatalogDiscovery, layerCatalogHandlers } from "@clavia/tardigrade-http/models"
import { layerRequestProblems } from "@clavia/tardigrade-http/contract"
import type { Env } from "../env"
import type { CloudflareDirectory } from "./directory"

// treeBoundsOf validates optional subtree, depth, and node limits (test/actor.workers.ts).
const treeBoundsOf = (
  request: HttpServerRequest.HttpServerRequest
): { readonly bounds: TreeBounds } | { readonly error: string } => {
  const query = new URL(request.url, "http://worker").searchParams
  const bounds = { root: query.get("root") ?? undefined, maxDepth: undefined as number | undefined, maxNodes: undefined as number | undefined }
  for (const [name, minimum] of [["maxDepth", 0], ["maxNodes", 1]] as const) {
    const raw = query.get(name)
    if (raw === null) continue
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < minimum) {
      return { error: `${name} must be ${minimum === 0 ? "a non-negative" : "a positive"} integer` }
    }
    bounds[name] = value
  }
  return { bounds }
}

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

  const workerRoute = <E, R>(
    f: (
      request: HttpServerRequest.HttpServerRequest,
      env: Env
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ) => Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const env = yield* WorkerEnv
    return yield* f(request, env)
  })

  const routes = [
    HttpRouter.route("GET", "/healthz", Effect.gen(function* () {
      return json({ status: "ready", actor: actorName() })
    })),
    HttpRouter.route("GET", "/v1/metadata", workerRoute((_request, _env) =>
      Effect.succeed(json({ name: actorName(), storage: { kind: "durable-object" } }))
    )),
    HttpRouter.route("PUT", "/v1/actors/:id", workerRoute((_request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const stub = yield* Effect.promise(() => actorStub(env, actorName(), instance, true))
        if (stub === undefined) return json({ error: "actor is not deployed" }, 503)
        return json({ actor: instance, definition: actorName() })
      })
    )),
    HttpRouter.route("GET", "/v1/actors/:id", workerRoute((_request, env) =>
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
    HttpRouter.route("POST", "/v1/actors/:id/threads", workerRoute((request, env) =>
      Effect.gen(function* () {
        const selection = invocationQueryOf(request)
        if ("error" in selection) return json({ error: selection.error }, 400)
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const payload = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (!Schema.is(Schema.Struct({ name: Schema.optionalKey(Schema.NonEmptyString), key: Schema.optionalKey(Schema.NonEmptyString), parent: Schema.optionalKey(Schema.NonEmptyString) }))(payload)) return json({ error: "name must be a nonempty string when supplied" }, 400)
        const directory = yield* Effect.promise(() => actorStub(env, actorName(), instance, true))
        if (directory === undefined) return json({ error: "unknown actor" }, 404)
        const coordinate = yield* Effect.promise(() => directory.createThread(payload.name, payload))
        return json(coordinate)
      })
    )),
    HttpRouter.route("GET", "/v1/actors/:id/threads", workerRoute((request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const stub = yield* Effect.promise(() => actorStub(env, actorName(), instance, false))
        if (stub === undefined) return json({ error: "unknown actor" }, 404)
        const selected = treeBoundsOf(request)
        if ("error" in selected) return json({ error: selected.error }, 400)
        const tree = yield* Effect.promise(() => stub.threadTree(selected.bounds))
        if (tree === undefined) return json({ error: "unknown thread" }, 404)
        return json(tree)
      })
    )),
    HttpRouter.route("POST", "/v1/actors/:id/threads/:thread/events", workerRoute((request, env) =>
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
    HttpRouter.route("GET", "/v1/actors/:id/threads/:thread/events", workerRoute((request, env) =>
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
    HttpRouter.route("GET", "/v1/actors/:id/threads/:thread/fact", workerRoute((request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        const thread = params.thread ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const stub = yield* Effect.promise(() => threadStub(env, actorName(), instance, thread))
        if (stub === undefined) return json({ error: "unknown thread" }, 404)
        const query = new URL(request.url, "http://worker").searchParams
        const key = query.get("key")
        const subject = query.get("subject")
        if (
          (key === null) === (subject === null) ||
          key === "" ||
          subject === "" ||
          (subject !== null && subject.length > MAX_SUBJECT_LENGTH)
        ) {
          return json({ error: `a fact query requires one nonempty key or one subject of at most ${MAX_SUBJECT_LENGTH} characters` }, 400)
        }
        return yield* Effect.tryPromise({
          try: () => stub.stub.fact(stub.thread, {
            ...(key === null ? {} : { key }),
            ...(subject === null ? {} : { subject })
          }),
          catch: (cause) => cause instanceof Error ? cause.message : String(cause)
        }).pipe(Effect.match({
          onFailure: (error) => json({ error }, 500),
          onSuccess: (resolved) => resolved.head === 0
            ? json({ error: "unknown thread" }, 404)
            : resolved.row === null
              ? json({ error: "unknown fact" }, 404)
              : json(resolved.row)
        }))
      })
    )),
    HttpRouter.route("POST", "/v1/actors/:id/threads/:thread/facts", workerRoute((request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        const thread = params.thread ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const stub = yield* Effect.promise(() => threadStub(env, actorName(), instance, thread))
        if (stub === undefined) return json({ error: "unknown thread" }, 404)
        const payload = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (!Schema.is(FactsRequest)(payload)) {
          return json({ error: `facts require 1 to ${MAX_SUBJECTS_PER_LOOKUP} subjects of at most ${MAX_SUBJECT_LENGTH} characters each` }, 400)
        }
        return yield* Effect.tryPromise({
          try: () => stub.stub.facts(stub.thread, payload.subjects),
          catch: (cause) => cause instanceof Error ? cause.message : String(cause)
        }).pipe(Effect.match({
          onFailure: (error) => json({ error }, 500),
          onSuccess: (resolved) => resolved.head === 0
            ? json({ error: "unknown thread" }, 404)
            : json(resolved.rows)
        }))
      })
    )),
    HttpRouter.route("*", "/*", json({ error: "not found" }, 404))
  ] as const

  const { handler } = HttpRouter.toWebHandler(Layer.mergeAll(
    HttpRouter.addAll(routes),
    HttpApiBuilder.layer(CatalogApi).pipe(Layer.provide(layerCatalogHandlers), Layer.provide(layerRequestProblems)),
    HttpApiBuilder.layer(MethodApi).pipe(Layer.provide(layerMethodHandlers), Layer.provide(layerRequestProblems)),
    HttpRouter.middleware((effect) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = new URL(request.url, "http://worker").pathname
      if (["/healthz", "/v1/providers", "/v1/models"].includes(path)) return yield* effect
      return guard(request, yield* WorkerEnv) ?? (yield* effect)
    }), { global: true })
  ).pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const actor = actorName()
      const methods = methodsOf(actor) ?? {}
      const runtime = MethodRuntime.of({
        actorName: actor,
        methods,
        instance: (instance) => Effect.gen(function* () {
          if ((yield* Effect.promise(() => actorStub(env, actor, instance, false))) === undefined) return undefined
          return {
            methods,
            events: (thread) => Effect.promise(async () => {
              const target = await threadStub(env, actor, instance, thread)
              return target === undefined ? [] : await target.stub.events(target.thread) as ReadonlyArray<Event>
            }),
            append: (thread, event) => Effect.gen(function* () {
              const target = yield* Effect.promise(() => threadStub(env, actor, instance, thread))
              if (target === undefined || !(yield* Effect.promise(() => target.stub.append(target.thread, event)))) {
                return yield* Effect.fail(UnknownThread.of(`No thread named ${JSON.stringify(thread)} has ever existed.`))
              }
            })
          }
        })
      })
      return handler(request, Context.make(WorkerEnv, env).pipe(Context.add(MethodRuntime, runtime), Context.add(CatalogDiscovery, {
        read: Effect.promise(async () => ({
          ...await publicCatalog(env),
          availability: providerAvailabilityFrom(env),
          policy: modelPolicyFrom(env)
        }))
      })))
    }
  } satisfies ExportedHandler<Env>
}
