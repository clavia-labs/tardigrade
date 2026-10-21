import { DEFAULT_METHOD_HTTP_INSTANCE } from "../shared/method-http"
export { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
export { executionStreamSse } from "../shared/execution-stream-sse"
import type { ActorMethods } from "@clavia/tardigrade-core"
import { makeRetryingAlarms, type CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { CLOUDFLARE_SQL_LIMITS } from "./limits"
export { CLOUDFLARE_SQL_LIMITS, CLOUDFLARE_SQLITE_MAX_ROW_BYTES, CLOUDFLARE_MAX_CHECKPOINT_CHUNK_BYTES } from "./limits"
import { type CheckpointChunkOptions, type JournalRecordOptions } from "../shared/sql-journal"
import { platformJournal } from "../shared/platform-journal"
import { cloudflareNativeDriver, checkNativeRecovery } from "./native-recovery"
import type { SynchronousRecoveryOptions } from "../shared/synchronous-journal"
export { synchronousJournal, DEFAULT_CHECKPOINT_COLLECT_EVERY, DEFAULT_CHECKPOINT_SCHEDULER, type CheckpointTreeOptions, DEFAULT_EVENT_INLINE_BYTES, type JournalRecordOptions, decodeSqlJournalRecord, DEFAULT_CHECKPOINT_CHUNK_BYTES, type SqlJournalLimits, type CheckpointChunkOptions } from "../shared/sql-journal"
export { hostRoutes, errorLogFields, DEFAULT_ERROR_LOG_POLICY, type ErrorLogPolicy, type HttpHost } from "../shared/http"
export { workerLoaderIsolate, DEFAULT_WORKER_LOADER_ISOLATE_POLICY, type WorkerLoaderIsolatePolicy } from "./isolate"
import { hostRoutes, type ErrorLogPolicy, type HttpHost } from "../shared/http"
import { HttpRouter } from "effect/unstable/http"

// cloudflareJournal commits to a Durable Object SQLite database and flushes before acknowledging an append.
export function cloudflareJournal<Event extends object>(storage: DurableObjectStorage, actor: string, options: CloudflareAlarmOptions & CheckpointChunkOptions & JournalRecordOptions & Pick<SynchronousRecoveryOptions, "scheduler" | "watchdog"> = {}) {
  const alarms = makeRetryingAlarms(storage, options)
  return platformJournal<Event>({
    actor,
    limits: CLOUDFLARE_SQL_LIMITS,
    checkpointChunkBytes: options.checkpointChunkBytes, eventInlineBytes: options.eventInlineBytes,
    driver: cloudflareNativeDriver(storage), scheduler: options.scheduler, watchdog: options.watchdog,
    flush: alarms.sync,
  }, options.checkpointTree, checkNativeRecovery(storage))
}

// cloudflareHandler exposes host routes as a Worker fetch handler; dispose releases HTTP resources.
export const cloudflareHandler = (host: HttpHost, errorLog?: Partial<ErrorLogPolicy>) => HttpRouter.toWebHandler(hostRoutes(host, errorLog), { disableLogger: true })

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

export { DEFAULT_DIRECTORY_PAGE_SIZE, registrationObjectName } from "./directory"
