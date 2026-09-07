import { cloudflareHttp } from "./transport/http"
import type { Actor, ActorMethods } from "@clavia/tardigrade-core/actor"
import type { InferenceObserver } from "@clavia/tardigrade-agent"
import { modelAdapters } from "@clavia/tardigrade-model/adapter"
import type { CommitObserver } from "@clavia/tardigrade-host/commit"
import { type CloudflareThreadStorePolicy } from "./storage"
import { type CloudflareThreadEnv } from "./host"
import type { Env } from "./env"
import { CLOUDFLARE_CHILD_PLACEMENTS, DEFAULT_CLOUDFLARE_CHILD_PLACEMENT, DEFAULT_BACKGROUND_TASK_OWNER, mountedActor, directory, providerAvailabilityFrom, modelPolicyFrom, publicCatalog, methodsOf, type CloudflareWorkerLayerContext, type CloudflareWorkerArguments, mountActor } from "./assembly"
import { ActorDO } from "./actor"
import { ThreadDO } from "./thread"
export { ActorDO, type ActorThreadNode } from "./actor"
export { ThreadDO } from "./thread"
export type { Env } from "./env"
export { DEFAULT_CLOUDFLARE_EVENT_LIMIT } from "./transport/http"
export { CLOUDFLARE_CHILD_PLACEMENTS, DEFAULT_CLOUDFLARE_CHILD_PLACEMENT, BACKGROUND_TASK_OWNERS, type BackgroundTaskOwner, DEFAULT_BACKGROUND_TASK_OWNER, backgroundTaskOwnerOf, retainBackgroundTask, type DeploymentModelScope, modelScopeFrom, modelCatalogForConfig, DEFAULT_CLOUDFLARE_MODEL_CATALOG_TIMEOUT_MILLIS, DEFAULT_CLOUDFLARE_MODEL_CATALOG_LOAD_POLICY, type CloudflareWorkerLayerContext, type CloudflareWorkerStoreFor, type CloudflareWorkerOptions } from "./assembly"

const http = cloudflareHttp({
  actorName: () => mountedActor!.name, methodsOf, publicCatalog,
  providerAvailabilityFrom, modelPolicyFrom, directory
})

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
  ...[options]: CloudflareWorkerArguments<R, WorkerEnv>
): ExportedHandler<WorkerEnv> => {
  const defaultChildPlacement = options?.defaultChildPlacement ?? DEFAULT_CLOUDFLARE_CHILD_PLACEMENT
  if (!CLOUDFLARE_CHILD_PLACEMENTS.includes(defaultChildPlacement as "independent")) {
    throw new Error(`Cloudflare Durable Object host does not support ${JSON.stringify(defaultChildPlacement)} thread placement`)
  }
  mountActor({
    ...(options?.threadAllocator === undefined ? {} : { threadAllocator: options.threadAllocator }),
    ...(options?.allocation === undefined ? {} : { allocation: options.allocation }),
    name: definition.name,
    actor: definition as unknown as Actor<never>,
    methods: definition.methods,
    modelAdapters: options?.modelAdapters ?? modelAdapters(),
    ...(options?.modelScope === undefined ? {} : { modelScope: options.modelScope }),
    defaultChildPlacement,
    backgroundTaskOwner: options?.backgroundTaskOwner ?? DEFAULT_BACKGROUND_TASK_OWNER,
    ...(options?.inferenceObserverFor === undefined ? {} : {
      inferenceObserverFor: options.inferenceObserverFor as unknown as (context: CloudflareWorkerLayerContext<Env>) => InferenceObserver
    }),
    ...(options?.commitObserverFor === undefined ? {} : {
      commitObserverFor: options.commitObserverFor as unknown as (context: CloudflareWorkerLayerContext<Env>) => CommitObserver
    }),
    ...(options?.layersFor === undefined ? {} : {
      layersFor: options.layersFor as unknown as (context: CloudflareWorkerLayerContext<Env>) => CloudflareThreadEnv<never>
    }),
    ...(options?.storeFor === undefined ? {} : {
      storeFor: options.storeFor as unknown as (context: CloudflareWorkerLayerContext<Env>) => CloudflareThreadStorePolicy
    })
  })
  return worker as ExportedHandler<WorkerEnv>
}

export default worker

// createWorker assembles a Worker handler and its Durable Object classes for an actor.
export const createWorker = <R, const Methods extends ActorMethods, WorkerEnv extends Env = Env>(
  definition: Actor<R, Methods>,
  ...options: CloudflareWorkerArguments<R, WorkerEnv>
) => ({ worker: cloudflareWorker<R, Methods, WorkerEnv>(definition, ...options), ActorDO, ThreadDO })
