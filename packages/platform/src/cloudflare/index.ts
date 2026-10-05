import { DEFAULT_METHOD_HTTP_INSTANCE } from "../shared/method-http"
export { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
export { executionStreamSse } from "../shared/execution-stream-sse"
import type { ActorMethods } from "@clavia/tardigrade-core"
import { makeRetryingAlarms, type CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { CLOUDFLARE_SQL_LIMITS } from "./limits"
export { CLOUDFLARE_SQL_LIMITS, CLOUDFLARE_SQLITE_MAX_ROW_BYTES, CLOUDFLARE_MAX_CHECKPOINT_CHUNK_BYTES } from "./limits"
import { sqlJournal, type CheckpointChunkOptions } from "../shared/sql-journal"
export { sqlJournal, DEFAULT_CHECKPOINT_CHUNK_BYTES, type SqlJournalLimits, type CheckpointChunkOptions } from "../shared/sql-journal"
export { hostRoutes, type HttpHost } from "../shared/http"
export { workerLoaderIsolate, DEFAULT_WORKER_LOADER_ISOLATE_POLICY, type WorkerLoaderIsolatePolicy } from "./isolate"
import { hostRoutes, type HttpHost } from "../shared/http"
import { HttpRouter } from "effect/unstable/http"

// cloudflareJournal commits to a Durable Object SQLite database and flushes before acknowledging an append.
export function cloudflareJournal<Event extends object>(storage: DurableObjectStorage, actor: string, options: CloudflareAlarmOptions & CheckpointChunkOptions = {}) {
  const alarms = makeRetryingAlarms(storage, options)
  return sqlJournal<Event>({
    actor,
    limits: CLOUDFLARE_SQL_LIMITS,
    checkpointChunkBytes: options.checkpointChunkBytes,
    layer: SqliteClient.layer({ storage }),
    flush: alarms.sync,
  })
}

// cloudflareHandler exposes host routes as a Worker fetch handler; dispose releases HTTP resources.
export const cloudflareHandler = (host: HttpHost) => HttpRouter.toWebHandler(hostRoutes(host), { disableLogger: true })

export { createActorObjects, cloudflareThreadName, CLOUDFLARE_CHILD_PLACEMENTS, DEFAULT_CLOUDFLARE_CHILD_PLACEMENT } from "./objects"
export type { ActorObjectOptions, CloudflareObjectBindings, ActorDirectoryStub, ThreadRuntimeStub } from "./objects"
import { createActorObjects, type ActorObjectOptions, type CloudflareObjectBindings } from "./objects"

// createActorObject owns an instance directory whose registered threads execute in separate DOs (test/workerd/thread-layout.workers.ts).
export function createActorObject<Env extends object = Record<string, unknown>, Event extends object = object, Services = never, State = unknown, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: ActorObjectOptions<Env, Event, Services, State, Contracts>) {
  return createActorObjects(options).ActorObject
}

// createThreadObject owns the storage, execution, and recovery of one registered thread (test/workerd/thread-layout.workers.ts).
export function createThreadObject<Env extends object = Record<string, unknown>, Event extends object = object, Services = never, State = unknown, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: ActorObjectOptions<Env, Event, Services, State, Contracts>) {
  return createActorObjects(options).ThreadObject
}

// createActorWorker routes instance requests to a directory DO and exports its thread DO class (test/workerd/thread-layout.workers.ts).
export function createActorWorker<Env extends object = Record<string, unknown>, Event extends object = object, Services = never, State = unknown, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: ActorObjectOptions<Env, Event, Services, State, Contracts>) {
  const objects = createActorObjects(options)
  return {
    ...objects,
    fetch(request: Request, env: Env & CloudflareObjectBindings) {
      const instance = /^\/v1\/actors\/([^/]+)\/threads(?:\/|$)/.exec(new URL(request.url).pathname)?.[1]
      return env.ACTORS.getByName(instance === undefined ? options.http?.(env).instance ?? DEFAULT_METHOD_HTTP_INSTANCE : decodeURIComponent(instance)).fetch(request)
    },
  }
}
export { cloudflarePromises, createCloudflarePromiseResolver, PromiseResolverCompletion, PromiseResolverNotification, type PromiseResolverStub } from "./promise-resolver"

export { httpMessageTransport } from "../shared/http-message"
export { rpcMessageTransport, type ActorReceiver } from "../shared/rpc-message"
