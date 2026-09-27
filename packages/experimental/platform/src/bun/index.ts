import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, ManagedRuntime, type Layer } from "effect"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { createThreadHost, type ThreadStorage } from "@clavia/tardigrade-experimental-core"
import { RemoteBackup, sqlJournal } from "@clavia/tardigrade-experimental-host"
import { captureHostCheckpoint, type CheckpointPolicy } from "./backup"
export { serve, DEFAULT_SERVE_OPTIONS, type ServeOptions } from "./serve"
export { bunBackup, restoreHostCheckpoint, DEFAULT_CHECKPOINT_POLICY, type CheckpointPolicy } from "./backup"

// bunJournal opens a SQLite event journal; its caller closes it after closing the actor.
export function bunJournal<Event extends object>(options: SqliteClient.SqliteClientConfig & { readonly actor: string }) {
  return sqlJournal<Event>({ actor: options.actor, layer: SqliteClient.layer(options) })
}

// createBunHost keeps an instance supervisor database and separate thread databases beneath storage.
export async function createBunHost<Event extends object, Services, Methods extends Readonly<Record<string, (...args: never[]) => Promise<void>>>, State>(options: Omit<Parameters<typeof createThreadHost<Event, Services, Methods, State>>[0], "storage"> & {
  readonly storage: string
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename">
  readonly backup?: Layer.Layer<RemoteBackup, Error>
  readonly checkpoint?: Partial<CheckpointPolicy>
}) {
  const connections = new Set<() => Promise<void>>()
  const encoded = (value: string) => Buffer.from(value).toString("base64url")
  const instanceFile = (actor: string, instance: string) => join(options.storage, `${encoded(JSON.stringify([actor, instance]))}.sqlite`)
  const journal = <Entry extends object>(filename: string, actor: string) => {
    mkdirSync(dirname(filename), { recursive: true })
    const opened = bunJournal<Entry>({ ...options.sqlite, filename, actor })
    connections.add(opened.close)
    return opened
  }
  const storage: ThreadStorage<Event> = {
    supervisor: (actor, instance) => journal(instanceFile(actor, instance), "supervisor"),
    thread: coordinate => journal(join(`${instanceFile(coordinate.actor, coordinate.instance)}.threads`, `${encoded(coordinate.thread)}.sqlite`), "events"),
    invocations: coordinate => journal(join(`${instanceFile(coordinate.actor, coordinate.instance)}.threads`, `${encoded(coordinate.thread)}.sqlite`), "invocations"),
    close: async () => {
      const failures: unknown[] = []
      for (const close of connections) { try { await close() } catch (error) { failures.push(error) } }
      connections.clear()
      if (failures.length) throw new AggregateError(failures, "Closing Bun journals failed")
    },
  }
  const host = createThreadHost({ ...options, storage })
  const runtime = options.backup ? ManagedRuntime.make(options.backup) : undefined
  let pending: Promise<unknown> = Promise.resolve()
  let closed = false
  let closing: Promise<void> | undefined
  return {
    ...host,
    backup: () => {
      if (closed) return Promise.reject(new Error("Bun host is closed"))
      if (!runtime) return Promise.reject(new Error("No backup layer was supplied"))
      const save = () => runtime.runPromise(Effect.gen(function*() {
        const backup = yield* RemoteBackup
        const checkpoint = yield* Effect.try(() => captureHostCheckpoint({ actor: host.actor, storage: options.storage, policy: options.checkpoint ?? {} }))
        yield* backup.save(checkpoint)
        return { id: checkpoint.id, createdAt: checkpoint.createdAt, digest: checkpoint.digest }
      }))
      const result = pending.then(save, save)
      pending = result.catch(() => {})
      return result
    },
    close: () => closing ??= (async () => {
      closed = true
      try {
        const results = await Promise.allSettled([pending, host.close()])
        const failure = results.find(result => result.status === "rejected")
        if (failure?.status === "rejected") throw failure.reason
      }
      finally { await runtime?.dispose() }
    })(),
  }
}
export { bunPromises } from "./promises"
