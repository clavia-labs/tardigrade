export { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
export { executionStreamSse } from "../shared/execution-stream-sse"
import { RuntimeError, Scheduler, type ActorMethods, createThreadHost, type ThreadStorage, type SchedulerPolicy, RemoteBackup } from "@clavia/tardigrade-core"
import { bunAlarm } from "./alarm"
import { bunSupervisorPath, bunThreadPath } from "./observe"
export { observeBunThread, observeBunSupervisor, bunThreadActivity } from "./observe"
import type { SqliteClient } from "@effect/sql-sqlite-bun"
import { Database } from "bun:sqlite"
import { Duration, Effect, ManagedRuntime, Semaphore, Exit, Layer } from "effect"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DEFAULT_CHECKPOINT_CHUNK_BYTES, validateCheckpointChunkBytes } from "../shared/checkpoint-chunks"
import { type CheckpointChunkOptions, type JournalRecordOptions } from "../shared/sql-journal"
import { platformJournal } from "../shared/platform-journal"
export { synchronousJournal, decodeSqlJournalRecord, DEFAULT_CHECKPOINT_COLLECT_EVERY, DEFAULT_CHECKPOINT_SCHEDULER, type CheckpointTreeOptions, DEFAULT_EVENT_INLINE_BYTES, type JournalRecordOptions, DEFAULT_CHECKPOINT_CHUNK_BYTES, type SqlJournalLimits, type CheckpointChunkOptions } from "../shared/sql-journal"
export { hostRoutes, errorLogFields, DEFAULT_ERROR_LOG_POLICY, type ErrorLogPolicy, type HttpHost } from "../shared/http"
import { captureHostCheckpoint, type CheckpointPolicy } from "./backup"
export { serve, DEFAULT_SERVE_OPTIONS, type ServeOptions } from "./serve"
export { bunBackup, restoreHostCheckpoint, DEFAULT_CHECKPOINT_POLICY, type CheckpointPolicy } from "./backup"

// bunJournal opens a SQLite event journal; its caller closes it after closing the actor.
export function bunJournal<Event extends object>(options: SqliteClient.SqliteClientConfig & CheckpointChunkOptions & JournalRecordOptions & { readonly actor: string; readonly scheduler?: Parameters<typeof platformJournal<Event>>[0]["scheduler"] }) {
  if (options.transformQueryNames || options.transformResultNames || options.spanAttributes) throw new RuntimeError("Native Bun journals do not support Effect SQL transforms or span attributes")
  const timeout = Math.min(2_147_483_647, Math.max(0, Math.round(Duration.toMillis(options.busyTimeout ?? DEFAULT_BUN_BUSY_TIMEOUT_MS))))
  const db = new Database(options.filename, { readonly: options.readonly ?? false, readwrite: options.readonly ? false : options.readwrite ?? true, create: options.readonly ? false : options.create ?? true })
  try {
    db.exec(`PRAGMA busy_timeout=${timeout}`)
    if (!options.disableWAL && !options.readonly) db.exec("PRAGMA journal_mode=WAL")
    const journal = platformJournal<Event>({ actor: options.actor, checkpointChunkBytes: options.checkpointChunkBytes, eventInlineBytes: options.eventInlineBytes, scheduler: options.scheduler,
      driver: { identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work).immediate() },
    }, options.checkpointTree)
    let closed = false
    return { ...journal, sqlite: { busyTimeoutMs: timeout, wal: !options.disableWAL && !options.readonly }, close: journal.close.pipe(Effect.andThen(Effect.sync(() => { if (!closed) { db.close(); closed = true } }))) }
  } catch (cause) { db.close(); throw cause }
}

export const DEFAULT_BUN_BUSY_TIMEOUT_MS = 5_000

// createBunHost keeps an instance supervisor database and separate thread databases beneath storage.
export function createBunHost<Event extends object, Services, State, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: Omit<Parameters<typeof createThreadHost<Event, Services, State, Contracts>>[0], "storage"> & {
  readonly storage: string
  readonly scheduler?: Partial<SchedulerPolicy>
  readonly checkpointTree?: CheckpointChunkOptions["checkpointTree"]
  readonly checkpointChunkBytes?: number
  readonly eventInlineBytes?: number
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
      const opened: ReturnType<typeof bunJournal<Entry>> = bunJournal<Entry>({ ...options.sqlite, filename, actor, checkpointChunkBytes: options.checkpointChunkBytes, checkpointTree: options.checkpointTree, eventInlineBytes: options.eventInlineBytes, ...(alarm ? { scheduler: {
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
