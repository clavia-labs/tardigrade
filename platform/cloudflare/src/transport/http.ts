import { Context, Effect, Layer, Schema } from "effect"
import { HttpServer, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ForkRequest, forkCheckpointOf, UnknownThread, type TreeBounds } from "@clavia/tardigrade-client/contract"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import type { ModelPolicy } from "@clavia/tardigrade-agent"
import type { ModelCatalogState } from "@clavia/tardigrade-model/catalog"
import type { providerAvailabilitiesOf } from "@clavia/tardigrade-model/catalog/availability"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { ActorInstanceId } from "@clavia/tardigrade-core/transport/endpoint"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MethodApi, MethodRuntime, layerMethodHandlers } from "@clavia/tardigrade-http/methods"
import { CatalogApi, CatalogDiscovery, layerCatalogHandlers } from "@clavia/tardigrade-http/models"
import { layerRequestProblems } from "@clavia/tardigrade-http/contract"
import { layerApiDocs, UNAUTHENTICATED_PATHS } from "@clavia/tardigrade-http/docs"
import { streamCursorOf } from "@clavia/tardigrade-http/sse"
import { WorkerApi, workerRoutes } from "./contract"
import type { Env } from "../env"
import type { CloudflareDirectory } from "./directory"
import type { ActorThreadNode } from "../actor"

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
export const DEFAULT_CLOUDFLARE_AUTHENTICATION = "bearer" as const

interface CloudflareHttpOptions {
  readonly authentication?: () => "bearer" | "none"
  readonly actorName: () => string
  readonly methodsOf: (name: string) => ActorMethods | undefined
  readonly publicCatalog: (env: Env) => Promise<ModelCatalogState>
  readonly providerAvailabilityFrom: (env: Env) => ReturnType<typeof providerAvailabilitiesOf>
  readonly modelPolicyFrom: (env: Env) => ModelPolicy
  readonly directory: CloudflareDirectory
}

// FORK_REFUSAL_STATUS maps a fork refusal to its HTTP status (packages/host/src/fork.ts, ForkRefusal).
const FORK_REFUSAL_STATUS = { "unknown-source": 404, checkpoint: 400, occupied: 409 } as const

// cloudflareHttp adapts HTTP requests to the mounted host's methods and directory.
export const cloudflareHttp = ({
  actorName, methodsOf, publicCatalog, providerAvailabilityFrom, modelPolicyFrom, directory,
  authentication = () => DEFAULT_CLOUDFLARE_AUTHENTICATION
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
    if (authentication() === "none") return undefined
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
    ...(["events", "inference", "threads"] as const).map((kind) => HttpRouter.route(
      "GET",
      kind === "threads" ? "/v1/actors/:id/threads/stream" : `/v1/actors/:id/threads/:thread/${kind}/stream`,
      workerRoute((request, env) => Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const url = new URL(request.url, "http://worker")
        const cursor = streamCursorOf(url.searchParams.get("after") ?? undefined, request.headers["last-event-id"])
        if ("invalid" in cursor) return json({ error: "stream cursor must be a non-negative safe integer" }, 400)
        const after = cursor.from
        let body: ReadableStream<Uint8Array>
        if (kind === "threads") {
          const stub = yield* Effect.promise(() => actorStub(env, actorName(), instance, false))
          if (stub === undefined) return json({ error: "unknown actor" }, 404)
          body = yield* Effect.promise(() => stub.threadStream(after))
        } else {
          const target = yield* Effect.promise(() => threadStub(env, actorName(), instance, params.thread ?? ""))
          if (target === undefined) return json({ error: "unknown thread" }, 404)
          const stream = yield* Effect.promise(() => kind === "events" ? target.stub.eventStream(after ?? 0) : target.stub.inferenceStream())
          if (stream === undefined) return json({ error: "unknown thread" }, 404)
          body = stream
        }
        return HttpServerResponse.raw(body, {
          contentType: "text/event-stream",
          headers: { "cache-control": "no-cache" }
        })
      }))
    )),
    HttpRouter.route(workerRoutes.healthz.method, workerRoutes.healthz.path, Effect.gen(function* () {
      return json({ status: "ready", actor: actorName() })
    })),
    HttpRouter.route(workerRoutes.metadata.method, workerRoutes.metadata.path, workerRoute((_request, _env) =>
      Effect.succeed(json({ name: actorName(), storage: { kind: "durable-object" } }))
    )),
    HttpRouter.route(workerRoutes.ensureActor.method, workerRoutes.ensureActor.path, workerRoute((_request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const stub = yield* Effect.promise(() => actorStub(env, actorName(), instance, true))
        if (stub === undefined) return json({ error: "actor is not deployed" }, 503)
        return json({ actor: instance, definition: actorName() })
      })
    )),
    HttpRouter.route(workerRoutes.actor.method, workerRoutes.actor.path, workerRoute((_request, env) =>
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
    HttpRouter.route(workerRoutes.allocateRoot.method, workerRoutes.allocateRoot.path, workerRoute((request, env) =>
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
    HttpRouter.route(workerRoutes.forkThread.method, workerRoutes.forkThread.path, workerRoute((request, env) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const instance = params.id ?? ""
        const thread = params.thread ?? ""
        if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
        const payload = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (!Schema.is(ForkRequest)(payload)) {
          return json({ error: "the body needs a checkpoint, { seq } at or above one or { event } naming an event id, and an optional nonempty name" }, 400)
        }
        const directory = yield* Effect.promise(() => actorStub(env, actorName(), instance, false))
        if (directory === undefined) return json({ error: "unknown actor" }, 404)
        const outcome = yield* Effect.promise(async () => directory.forkThread(thread, forkCheckpointOf(payload), payload.name))
        return outcome.ok
          ? json({ ...outcome.coordinate, seq: outcome.seq })
          : json({ error: outcome.message }, FORK_REFUSAL_STATUS[outcome.refusal])
      })
    )),
    HttpRouter.route(workerRoutes.list.method, workerRoutes.list.path, workerRoute((request, env) =>
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
        const flatten = (nodes: ReadonlyArray<ActorThreadNode>): ReadonlyArray<ActorThreadNode> =>
          nodes.flatMap((node) => [node, ...flatten(node.children)])
        const summaries = yield* Effect.forEach(flatten(tree), (node) => Effect.promise(async () => {
          const target = await threadStub(env, actorName(), instance, node.id)
          if (target === undefined) throw new Error("registered thread is missing its Durable Object")
          return target.stub.summary()
        }))
        return json(summaries)
      })
    )),
    HttpRouter.route(workerRoutes.append.method, workerRoutes.append.path, workerRoute((request, env) =>
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
    HttpRouter.route(workerRoutes.events.method, workerRoutes.events.path, workerRoute((request, env) =>
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

  const { handler } = HttpRouter.toWebHandler(Layer.mergeAll(
    HttpRouter.addAll(routes),
    layerApiDocs(WorkerApi),
    HttpApiBuilder.layer(CatalogApi).pipe(Layer.provide(layerCatalogHandlers), Layer.provide(layerRequestProblems)),
    HttpApiBuilder.layer(MethodApi).pipe(Layer.provide(layerMethodHandlers), Layer.provide(layerRequestProblems)),
    HttpRouter.middleware((effect) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = new URL(request.url, "http://worker").pathname
      if (UNAUTHENTICATED_PATHS.includes(path)) return yield* effect
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
