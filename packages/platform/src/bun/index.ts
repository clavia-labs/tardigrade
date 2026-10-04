export { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
export { executionStreamSse } from "../shared/execution-stream-sse"
import { RuntimeError, type ActorMethods, createThreadHost, type ThreadStorage, RemoteBackup } from "@clavia/tardigrade-core"
import { bunSupervisorPath, bunThreadPath } from "./observe"
export { observeBunThread, observeBunSupervisor, bunThreadActivity } from "./observe"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, ManagedRuntime, Semaphore, Exit, type Layer } from "effect"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { sqlJournal, type CheckpointChunkOptions } from "../shared/sql-journal"
export { sqlJournal, DEFAULT_CHECKPOINT_CHUNK_BYTES, type CheckpointChunkOptions } from "../shared/sql-journal"
export { hostRoutes, type HttpHost } from "../shared/http"
import { captureHostCheckpoint, type CheckpointPolicy } from "./backup"
export { serve, DEFAULT_SERVE_OPTIONS, type ServeOptions } from "./serve"
export { bunBackup, restoreHostCheckpoint, DEFAULT_CHECKPOINT_POLICY, type CheckpointPolicy } from "./backup"

// bunJournal opens a SQLite event journal; its caller closes it after closing the actor.
export function bunJournal<Event extends object>(options: SqliteClient.SqliteClientConfig & CheckpointChunkOptions & { readonly actor: string }) {
  return sqlJournal<Event>({ actor: options.actor, checkpointChunkBytes: options.checkpointChunkBytes, layer: SqliteClient.layer(options) })
}

// createBunHost keeps an instance supervisor database and separate thread databases beneath storage.
export function createBunHost<Event extends object, Services, State, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: Omit<Parameters<typeof createThreadHost<Event, Services, State, Contracts>>[0], "storage"> & {
  readonly storage: string
  readonly checkpointChunkBytes?: number
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename">
  readonly backup?: Layer.Layer<RemoteBackup, Error>
  readonly checkpoint?: Partial<CheckpointPolicy>
}) {
  return Effect.gen(function* () {
    const connections = new Set<Effect.Effect<void, Error>>()
    const journal = <Entry extends object>(filename: string, actor: string) => {
      mkdirSync(dirname(filename), { recursive: true })
      const opened = bunJournal<Entry>({ ...options.sqlite, filename, actor, checkpointChunkBytes: options.checkpointChunkBytes })
      connections.add(opened.close)
      return opened
    }
    const storage: ThreadStorage<Event> = {
      supervisor: (actor, instance) => journal(bunSupervisorPath(options.storage, actor, instance), "supervisor"),
      thread: coordinate => journal(bunThreadPath(options.storage, coordinate), "events"),
      close: Effect.gen(function* () {
        const results = yield* Effect.forEach(connections, close => Effect.exit(close))
        connections.clear()
        const failure = results.find(Exit.isFailure)
        if (failure && Exit.isFailure(failure)) return yield* Effect.failCause(failure.cause)
      }),
    }
    const host = createThreadHost({ ...options, storage })
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

export { bunIsolate, DEFAULT_ISOLATE_POLICY, type IsolatePolicy } from "./isolate"

export { httpMessageTransport } from "../shared/http-message"
export { rpcMessageTransport, type ActorReceiver } from "../shared/rpc-message"
