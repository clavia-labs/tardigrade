import type { HttpRouter } from "effect/unstable/http"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { actorsGroup, methodsGroup, modelsGroup, runtimeGroup, threadsGroup, ActorThread } from "@clavia/tardigrade-client/contract"
import { ChildPlacement } from "@clavia/tardigrade-core/interaction/relations"
import type { ActorThreadNode } from "../actor"

const ThreadTree = Schema.Struct({
  ...ActorThread.fields,
  placement: Schema.optionalKey(ChildPlacement),
  children: Schema.Array(Schema.suspend((): Schema.Codec<ActorThreadNode> => ThreadTree))
}).annotate({ identifier: "WorkerThreadTree" })

const WorkerActor = Schema.Struct({ actor: Schema.String, definition: Schema.String })

const WorkerError = Schema.Struct({ error: Schema.String })
const errors = [400, 401, 404, 500, 503].map((status) => WorkerError.pipe(HttpApiSchema.status(status)))

// workerEndpoint retains shared requests and replaces the manual transport's response declarations (test/actor.workers.ts).
const workerEndpoint = (endpoint: Pick<HttpApiEndpoint.Top, "identifier" | "method" | "params" | "query" | "headers" | "payload" | "success"> & { readonly path: HttpRouter.PathInput }, success: ReadonlyArray<Schema.Top> = [...endpoint.success]) => {
  const payload = [...endpoint.payload.values()].flatMap((entry) => entry.schemas)
  return HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
    params: endpoint.params,
    query: endpoint.query,
    headers: endpoint.headers,
    ...(payload.length === 0 ? {} : { payload }),
    success,
    error: errors
  })
}

// workerRoutes declares the manual Worker routes, including runtime-specific responses (test/actor.workers.ts).
export const workerRoutes = {
  healthz: HttpApiEndpoint.get("healthz", "/healthz", {
    success: Schema.Struct({ status: Schema.Literal("ready"), actor: Schema.String })
  }),
  metadata: workerEndpoint(runtimeGroup.endpoints.metadata),
  ensureActor: workerEndpoint(actorsGroup.endpoints.ensureActor, [WorkerActor]),
  actor: workerEndpoint(actorsGroup.endpoints.actor, [WorkerActor]),
  allocateRoot: workerEndpoint(threadsGroup.endpoints.allocateRoot),
  list: workerEndpoint(threadsGroup.endpoints.list, [Schema.Array(ThreadTree)]),
  append: workerEndpoint(threadsGroup.endpoints.append),
  events: workerEndpoint(threadsGroup.endpoints.events)
}

// WorkerApi describes the routes mounted by cloudflareHttp (test/actor.workers.ts).
export const WorkerApi = HttpApi.make("tardigrade-worker").add(
  modelsGroup,
  methodsGroup,
  HttpApiGroup.make("worker").add(workerRoutes.healthz, workerRoutes.metadata, workerRoutes.ensureActor, workerRoutes.actor, workerRoutes.allocateRoot, workerRoutes.list, workerRoutes.append, workerRoutes.events)
).annotateMerge(OpenApi.annotations({ title: "Tardigrade", description: "Durable actor methods and thread logs on Cloudflare Workers." }))
