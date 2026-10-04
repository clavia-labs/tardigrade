import { DEFAULT_METHOD_HTTP_INSTANCE } from "../shared/method-http"
export { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
export { executionStreamSse } from "../shared/execution-stream-sse"
import { Effect, Exit, Fiber } from "effect"
import { createWatchdog, watchdogKey, type WatchdogPolicy, type WatchdogTarget, type ActorMethods, createThreadHost, type ThreadStorage } from "@clavia/tardigrade-core"
import { makeRetryingAlarms, type CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { cloudflareWatchdogStorage } from "./watchdog"
import { sqlJournal, type CheckpointChunkOptions } from "../shared/sql-journal"
export { sqlJournal, DEFAULT_CHECKPOINT_CHUNK_BYTES, type CheckpointChunkOptions } from "../shared/sql-journal"
export { hostRoutes, type HttpHost } from "../shared/http"
import { hostRoutes, type HttpHost } from "../shared/http"
import { HttpRouter } from "effect/unstable/http"

// cloudflareJournal commits to a Durable Object SQLite database and flushes before acknowledging an append.
export function cloudflareJournal<Event extends object>(storage: DurableObjectStorage, actor: string, options: CloudflareAlarmOptions & CheckpointChunkOptions = {}) {
  const alarms = makeRetryingAlarms(storage, options)
  return sqlJournal<Event>({
    actor,
    checkpointChunkBytes: options.checkpointChunkBytes,
    layer: SqliteClient.layer({ storage }),
    flush: alarms.sync,
  })
}

/** @deprecated Use createActorWorker for separate supervisor and thread databases. */
// createActorHost keeps supervisor and thread journals in the supplied Durable Object storage.
export function createActorHost<Event extends object, Services, State, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: Omit<Parameters<typeof createThreadHost<Event, Services, State, Contracts>>[0], "storage"> & {
  readonly storage: DurableObjectStorage
  readonly checkpointChunkBytes?: number
  readonly alarms?: CloudflareAlarmOptions
  readonly watchdog?: { readonly policy?: Partial<WatchdogPolicy>; readonly retryable?: (error: Error) => boolean }
}) {
  let host!: ReturnType<typeof createThreadHost<Event, Services, State, Contracts>>
  const recoveries = new Set<Fiber.Fiber<void, Error>>()
  const watchdog = createWatchdog({ storage: cloudflareWatchdogStorage(options.storage, options.alarms), recover: target => host.recover(target), probe: target => host.probe(target), invalidate: target => host.invalidate(target),
    launch: work => Effect.sync(() => {
      const fiber = Effect.runFork(work)
      recoveries.add(fiber)
      fiber.addObserver(() => { recoveries.delete(fiber) })
    }), ...options.watchdog })
  const connections = new Set<Effect.Effect<void, Error>>()
  const journal = <Entry extends object>(key: readonly string[], target: WatchdogTarget) => {
    const opened = objectJournal<Entry>({ storage: options.storage, key: JSON.stringify(key), checkpointChunkBytes: options.checkpointChunkBytes, target, watchdog, alarms: options.alarms })
    connections.add(opened.close)
    return opened
  }
  const storage: ThreadStorage<Event> = {
    supervisor: (actor, instance) => journal([actor, instance, "supervisor"], { actor, instance }),
    thread: coordinate => journal([coordinate.actor, coordinate.instance, "thread", coordinate.thread, "events"], coordinate),
    close: Effect.gen(function* () {
      const results = yield* Effect.forEach(connections, close => Effect.exit(close))
      connections.clear()
      const failure = results.find(Exit.isFailure)
      if (failure && Exit.isFailure(failure)) return yield* Effect.failCause(failure.cause)
    }),
  }
  host = createThreadHost({ ...options, storage, canDrive: target => watchdog.status.pipe(Effect.flatMap(entries => entries.get(watchdogKey(target))?.status === "blocked" ? Effect.succeed(false) : options.canDrive ? options.canDrive(target) : Effect.succeed(true))) })
  return { ...host, alarm: watchdog.alarm, watchdog, close: Effect.gen(function* () {
    yield* Effect.forEach(recoveries, Fiber.interrupt, { concurrency: "unbounded" })
    recoveries.clear()
    yield* host.close
  }) }
}

/** @deprecated Use createActorHost for new Cloudflare hosts. */
export const createCloudflareHost = createActorHost

// cloudflareHandler exposes host routes as a Worker fetch handler; dispose releases HTTP resources.
export const cloudflareHandler = (host: HttpHost) => HttpRouter.toWebHandler(hostRoutes(host), { disableLogger: true })

export { createActorObjects, cloudflareThreadName, CLOUDFLARE_CHILD_PLACEMENTS, DEFAULT_CLOUDFLARE_CHILD_PLACEMENT } from "./objects"
export type { ActorObjectOptions, CloudflareObjectBindings, ActorDirectoryStub, ThreadRuntimeStub } from "./objects"
import { createActorObjects, objectJournal, type ActorObjectOptions, type CloudflareObjectBindings } from "./objects"

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
