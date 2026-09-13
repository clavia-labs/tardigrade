import type { ModelIntegrationOptions } from "@clavia/tardigrade-model/host"
import { cloudflareHttp } from "./transport/http"
import type { Actor, ActorMethods } from "@clavia/tardigrade-core/actor"
import type { Env } from "./env"
import { mountedActor, directory, providerAvailabilityFrom, modelPolicyFrom, publicCatalog, methodsOf, type CloudflareWorkerArguments, type CloudflareWorkerOptions, type DeploymentModelScope, mountActor } from "./assembly"
import { ActorDO } from "./actor"
import { ThreadDO } from "./thread"
export { ActorDO, type ActorThreadNode } from "./actor"
export { ThreadDO } from "./thread"
export type { Env } from "./env"
export { DEFAULT_CLOUDFLARE_EVENT_LIMIT } from "./transport/http"
export { CLOUDFLARE_CHILD_PLACEMENTS, DEFAULT_CLOUDFLARE_CHILD_PLACEMENT, BACKGROUND_TASK_OWNERS, type BackgroundTaskOwner, DEFAULT_BACKGROUND_TASK_OWNER, backgroundTaskOwnerOf, retainBackgroundTask, type DeploymentModelScope, modelScopeFrom, modelCatalogForConfig, DEFAULT_CLOUDFLARE_MODEL_CATALOG_TIMEOUT_MILLIS, DEFAULT_CLOUDFLARE_MODEL_CATALOG_LOAD_POLICY, type CloudflareWorkerLayerContext, type CloudflareWorkerStoreFor, type CloudflareWorkerOptions } from "./assembly"

const http = cloudflareHttp({
  actorName: () => mountedActor!.actor.name, methodsOf, publicCatalog,
  providerAvailabilityFrom, modelPolicyFrom, directory
})

export type WorkerHttp<WorkerEnv extends Env = Env> = Required<Pick<ExportedHandler<WorkerEnv>, "fetch">>

const worker: ExportedHandler<Env> = {
  fetch: (request, env, context) => mountedActor === undefined
    ? Response.json({ error: "no actor is mounted; call createWorker(actor) in the Worker entry point" }, { status: 503 })
    : http.fetch!(request, env, context)
}

// cloudflareWorker mounts a defined actor and its application layers into the Worker host (test/actor.workers.ts, "a mounted actor receives thread application services").
export const cloudflareWorker = <
  R,
  const Methods extends ActorMethods,
  WorkerEnv extends Env = Env
>(
  definition: Actor<R, Methods>,
  ...options: CloudflareWorkerArguments<R, WorkerEnv>
): ExportedHandler<WorkerEnv> => {
  mountActor<R, Methods, WorkerEnv>(definition, ...options)
  return worker as ExportedHandler<WorkerEnv>
}

export default worker

export interface WorkerModelServicesOptions {
  readonly model?: ModelIntegrationOptions
  readonly scope?: DeploymentModelScope
}

// workerModelServices configures the deployment catalog for thread execution.
export const workerModelServices = (options: WorkerModelServicesOptions) =>
  ({ ...(options.model === undefined ? {} : { model: options.model }), ...(options.scope === undefined ? {} : { modelScope: options.scope }) })

export type WorkerHostOptions<R, WorkerEnv extends Env = Env> = Omit<CloudflareWorkerOptions<R, WorkerEnv>, "modelScope"> & {
  readonly services?: ReturnType<typeof workerModelServices>
}

type WorkerHostArguments<R, WorkerEnv extends Env> = {} extends WorkerHostOptions<R, WorkerEnv>
  ? [options?: WorkerHostOptions<R, WorkerEnv>]
  : [options: WorkerHostOptions<R, WorkerEnv>]

const handler = Symbol("workerHandler")

export interface WorkerHost<WorkerEnv extends Env = Env> {
  readonly ActorDO: typeof ActorDO
  readonly ThreadDO: typeof ThreadDO
  readonly [handler]: WorkerHttp<WorkerEnv>
}

// defineWorkerHost mounts an actor and defines the Durable Object classes that execute it.
export const defineWorkerHost = <R, const Methods extends ActorMethods, WorkerEnv extends Env = Env>(
  definition: Actor<R, Methods>,
  ...[options]: WorkerHostArguments<R, WorkerEnv>
): WorkerHost<WorkerEnv> => {
  const { services, ...hostOptions } = options ?? {} as WorkerHostOptions<R, WorkerEnv>
  mountActor<R, Methods, WorkerEnv>(definition, ...[{ ...hostOptions, ...services }] as CloudflareWorkerArguments<R, WorkerEnv>)
  return { ActorDO, ThreadDO, [handler]: worker as WorkerHttp<WorkerEnv> }
}

// workerHttp supplies the HTTP fetch handler for a mounted Worker host.
export const workerHttp = <WorkerEnv extends Env>(host: WorkerHost<WorkerEnv>): WorkerHttp<WorkerEnv> => host[handler]

// serveWorker preserves the original Worker HTTP adapter name.
export const serveWorker = workerHttp

// createWorker preserves the combined Worker host and HTTP factory.
export const createWorker = <R, const Methods extends ActorMethods, WorkerEnv extends Env = Env>(
  definition: Actor<R, Methods>,
  ...options: CloudflareWorkerArguments<R, WorkerEnv>
) => ({
  worker: cloudflareWorker<R, Methods, WorkerEnv>(definition, ...options),
  ActorDO,
  ThreadDO
})
