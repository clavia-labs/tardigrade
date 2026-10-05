export { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
export { executionStreamSse } from "../shared/execution-stream-sse"
import { RuntimeError, Scheduler, type ActorMethods, createThreadHost, type ThreadStorage, type SchedulerPolicy, RemoteBackup } from "@clavia/tardigrade-core"
import { bunAlarm } from "./alarm"
import { bunSupervisorPath, bunThreadPath } from "./observe"
export { observeBunThread, observeBunSupervisor, bunThreadActivity } from "./observe"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, ManagedRuntime, Semaphore, Exit, Layer } from "effect"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DEFAULT_CHECKPOINT_CHUNK_BYTES, validateCheckpointChunkBytes } from "../shared/checkpoint-chunks"
import { sqlJournal, type CheckpointChunkOptions } from "../shared/sql-journal"
export { sqlJournal, DEFAULT_CHECKPOINT_CHUNK_BYTES, type SqlJournalLimits, type CheckpointChunkOptions } from "../shared/sql-journal"
export { hostRoutes, type HttpHost } from "../shared/http"
import { captureHostCheckpoint, type CheckpointPolicy } from "./backup"
export { serve, DEFAULT_SERVE_OPTIONS, type ServeOptions } from "./serve"
export { bunBackup, restoreHostCheckpoint, DEFAULT_CHECKPOINT_POLICY, type CheckpointPolicy } from "./backup"

// bunJournal opens a SQLite event journal; its caller closes it after closing the actor.
export function bunJournal<Event extends object>(options: SqliteClient.SqliteClientConfig & CheckpointChunkOptions & { readonly actor: string; readonly scheduler?: Parameters<typeof sqlJournal<Event>>[0]["scheduler"] }) {
  return sqlJournal<Event>({ actor: options.actor, checkpointChunkBytes: options.checkpointChunkBytes, layer: SqliteClient.layer(options), scheduler: options.scheduler })
}

// createBunHost keeps an instance supervisor database and separate thread databases beneath storage.
export function createBunHost<Event extends object, Services, State, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: Omit<Parameters<typeof createThreadHost<Event, Services, State, Contracts>>[0], "storage"> & {
  readonly storage: string
  readonly scheduler?: Partial<SchedulerPolicy>
  readonly checkpointChunkBytes?: number
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename">
  readonly backup?: Layer.Layer<RemoteBackup, Error>
  readonly checkpoint?: Partial<CheckpointPolicy>
}) {
  return Effect.gen(function* () {
    yield* Effect.try({ try: () => validateCheckpointChunkBytes(options.checkpointChunkBytes ?? DEFAULT_CHECKPOINT_CHUNK_BYTES), catch: RuntimeError.from })
    const schedulers = new Map<string, typeof Scheduler.Service>()
    const connections = new Set<Effect.Effect<void, Error>>()
    const journal = <Entry extends object>(filename: string, actor: string, target?: { actor: string; instance: string; thread: string }) => {
      mkdirSync(dirname(filename), { recursive: true })
      const alarm: ReturnType<typeof bunAlarm> | undefined = target ? bunAlarm(Effect.suspend(() => opened.scheduler!.alarm), { retryIntervalMs: options.scheduler?.deliveryRetryMs }) : undefined
      const opened: ReturnType<typeof bunJournal<Entry>> = bunJournal<Entry>({ ...options.sqlite, filename, actor, checkpointChunkBytes: options.checkpointChunkBytes, ...(alarm ? { scheduler: {
        alarm: alarm.alarm, policy: options.scheduler,
        deliver: () => Effect.suspend(() => host.getThread(target!).pipe(Effect.flatMap(thread => thread ? thread.resume : Effect.fail(new RuntimeError("Scheduled thread was not found"))))),
      } } : {}) })
      if (target && opened.scheduler) schedulers.set(JSON.stringify([target.actor, target.instance, target.thread]), opened.scheduler)
      if (alarm) connections.add(alarm.close)
      connections.add(opened.close)
      return opened
    }
    const storage: ThreadStorage<Event> = {
      supervisor: (actor, instance) => journal(bunSupervisorPath(options.storage, actor, instance), "supervisor"),
      thread: coordinate => journal(bunThreadPath(options.storage, coordinate), "events", coordinate),
      close: Effect.gen(function* () {
        const results = yield* Effect.forEach(connections, close => Effect.exit(close))
        connections.clear()
        const failure = results.find(Exit.isFailure)
        if (failure && Exit.isFailure(failure)) return yield* Effect.failCause(failure.cause)
      }),
    }
    const host = createThreadHost({ ...options, storage, services: (coordinate, runtime) => {
      const scheduler = schedulers.get(JSON.stringify([coordinate.actor, coordinate.instance, coordinate.thread]))
      const services = options.services(coordinate, runtime)
      return scheduler ? services.pipe(Layer.provideMerge(Layer.succeed(Scheduler, scheduler))) : services
    } })
    const runtime = options.backup ? ManagedRuntime.make(options.backup) : undefined
    const lock = yield* Semaphore.make(1)
    let closed = false
    const closing = yield* Effect.cached(Effect.gen(function* () {
      closed = true
      yield* lock.withPermit(host.close).pipe(Effect.ensuring(runtime?.disposeEffect ?? Effect.void))
    }).pipe(Effect.uninterruptible))
    return {
      ...host,
      backup: lock.withPermit(Effect.gen(function* () {
        if (closed) return yield* Effect.fail(new RuntimeError("Bun host is closed"))
        if (!runtime) return yield* Effect.fail(new RuntimeError("No backup layer was supplied"))
        const context = yield* runtime.contextEffect
        return yield* Effect.gen(function* () {
          const backup = yield* RemoteBackup
          const checkpoint = yield* Effect.try(() => captureHostCheckpoint({ actor: host.actor, storage: options.storage, policy: options.checkpoint ?? {} }))
          yield* backup.save(checkpoint)
          return { id: checkpoint.id, createdAt: checkpoint.createdAt, digest: checkpoint.digest }
        }).pipe(Effect.provide(context))
      })),
      close: closing,
    }
  })
}
export { bunPromises } from "./promises"
export { MAX_BUN_TIMER_DELAY_MS } from "./alarm"

export { bunIsolate, DEFAULT_ISOLATE_POLICY, type IsolatePolicy } from "./isolate"

export { httpMessageTransport } from "../shared/http-message"
export { rpcMessageTransport, type ActorReceiver } from "../shared/rpc-message"
