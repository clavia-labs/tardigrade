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

// workerEndpoint retains shared requests and replaces the manual transport's response declarations (test/actor.workers.ts).
const workerEndpoint = <const Name extends string>(endpoint: Pick<HttpApiEndpoint.Top, "method" | "params" | "query" | "headers" | "payload" | "success"> & { readonly identifier: Name; readonly path: HttpRouter.PathInput }, errors: ReadonlyArray<number>, success: ReadonlyArray<Schema.Top> = [...endpoint.success]) => {
  const payload = [...endpoint.payload.values()].flatMap((entry) => entry.schemas)
  return HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
    params: endpoint.params,
    query: endpoint.query,
    headers: endpoint.headers,
    ...(payload.length === 0 ? {} : { payload }),
    success,
    error: [401, 503, ...errors].map((status) => WorkerError.pipe(HttpApiSchema.status(status)))
  })
}

const workerGroup = HttpApiGroup.make("worker").add(
  HttpApiEndpoint.get("healthz", "/healthz", {
    success: Schema.Struct({ status: Schema.Literal("ready"), actor: Schema.String })
  }),
  workerEndpoint(runtimeGroup.endpoints.metadata, []),
  workerEndpoint(actorsGroup.endpoints.ensureActor, [400], [WorkerActor]),
  workerEndpoint(actorsGroup.endpoints.actor, [400, 404], [WorkerActor]),
  workerEndpoint(threadsGroup.endpoints.allocateRoot, [400, 404]),
  workerEndpoint(threadsGroup.endpoints.list, [400, 404], [Schema.Array(ThreadTree)]),
  workerEndpoint(threadsGroup.endpoints.append, [400, 404]),
  workerEndpoint(threadsGroup.endpoints.events, [400, 404, 500])
)

// workerRoutes declares the manual Worker routes, including runtime-specific responses (test/actor.workers.ts).
export const workerRoutes = workerGroup.endpoints

// WorkerApi describes the routes mounted by cloudflareHttp (test/actor.workers.ts).
export const WorkerApi = HttpApi.make("tardigrade-worker").add(
  modelsGroup,
  methodsGroup,
  workerGroup
).annotateMerge(OpenApi.annotations({ title: "Tardigrade", description: "Durable actor methods and thread logs on Cloudflare Workers." }))
