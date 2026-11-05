import { DEFAULT_METHOD_HTTP_INSTANCE } from "../shared/method-http"
export { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
export { executionStreamSse } from "../shared/execution-stream-sse"
import type { ActorMethods } from "@clavia/tardigrade-core"
import { makeRetryingAlarms, type CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { CLOUDFLARE_SQL_LIMITS } from "./limits"
export { CLOUDFLARE_SQL_LIMITS, CLOUDFLARE_SQLITE_MAX_ROW_BYTES, CLOUDFLARE_MAX_CHECKPOINT_CHUNK_BYTES } from "./limits"
import { sqlJournal, type CheckpointChunkOptions, type JournalRecordOptions } from "../shared/sql-journal"
export { sqlJournal, DEFAULT_EVENT_INLINE_BYTES, DEFAULT_INVOCATION_INDEX_BATCH_SIZE, type JournalRecordOptions, decodeSqlJournalRecord, DEFAULT_CHECKPOINT_CHUNK_BYTES, DEFAULT_FAMILY_INDEX_BATCH_SIZE, type FamilyIndexOptions, type SqlJournalLimits, type CheckpointChunkOptions } from "../shared/sql-journal"
export { hostRoutes, errorLogFields, DEFAULT_ERROR_LOG_POLICY, type ErrorLogPolicy, type HttpHost } from "../shared/http"
export { workerLoaderIsolate, DEFAULT_WORKER_LOADER_ISOLATE_POLICY, type WorkerLoaderIsolatePolicy } from "./isolate"
import { hostRoutes, type ErrorLogPolicy, type HttpHost } from "../shared/http"
import { HttpRouter } from "effect/http"

// cloudflareJournal commits to a Durable Object SQLite database and flushes before acknowledging an append.
export function cloudflareJournal<Event extends object>(storage: DurableObjectStorage, actor: string, options: CloudflareAlarmOptions & CheckpointChunkOptions & JournalRecordOptions = {}) {
  const alarms = makeRetryingAlarms(storage, options)
  return sqlJournal<Event>({
    actor,
    limits: CLOUDFLARE_SQL_LIMITS,
    checkpointChunkBytes: options.checkpointChunkBytes, eventInlineBytes: options.eventInlineBytes,
    familyIndexBatchSize: options.familyIndexBatchSize,
    invocationIndexBatchSize: options.invocationIndexBatchSize,
    layer: SqliteClient.layer({ storage }),
    transaction: work => storage.transactionSync(work),
    flush: alarms.sync,
  })
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

export { createWorkspaceObject, DEFAULT_WORKSPACE_INACTIVITY_TIMEOUT_MS, workspaceObjectName, r2Mount, containerWorkspace, mountedWorkspace, remoteWorkspace, S3Gateway, DEFAULT_CONTAINER_WORKSPACE_POLICY, DEFAULT_WORKSPACE_RELEASE, DEFAULT_R2_MOUNT_REGION, DEFAULT_R2_MOUNT_ACCESS, type WorkspaceObjectOptions, type R2MountOptions, type ContainerWorkspaceOptions, type ContainerWorkspacePolicy, type WorkspaceMount, type WorkspaceRelease, type RemoteWorkspace } from "./workspace"

export { virtualWorkspace, createVirtualWorkspaceObject, type VirtualWorkspaceObjectOptions } from "./virtual-workspace"
export { DEFAULT_VIRTUAL_WORKSPACE_DIRECTORY, DEFAULT_VIRTUAL_WORKSPACE_CHUNK_BYTES, DEFAULT_VIRTUAL_WORKSPACE_POLICY, DEFAULT_VIRTUAL_BASH_PROFILE, type VirtualWorkspaceOptions, type VirtualWorkspacePolicy, type VirtualWorkspaceExecutor } from "../shared/workspace/virtual/index"

export { sqlIdempotencyStore } from "../shared/workspace/idempotency-store"
export { objectStorageFromR2, DEFAULT_R2_OBJECT_PREFIX, DEFAULT_R2_MULTIPART_PART_BYTES, DEFAULT_R2_STAGING_PREFIX, R2_MIN_MULTIPART_PART_BYTES, R2_MAX_MULTIPART_PARTS, R2_MAX_UPLOAD_BYTES, type R2ObjectStorageOptions, type R2ObjectCacheOptions, type R2ObjectStreamOptions } from "@clavia/tardigrade-cloudflare/object-storage/r2"
export { DEFAULT_WORKSPACE_NETWORK_POLICY, workspaceNetworkPolicy, type WorkspaceNetworkPolicy } from "./workspace"
export { WorkspaceNetworkProxy } from "./workspace"
