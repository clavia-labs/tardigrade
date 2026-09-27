import { Context, Data, Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

// HostCheckpoint carries host-defined archive bytes and metadata for remote storage.
export interface HostCheckpoint {
  readonly id: string
  readonly actor: string
  readonly createdAt: number
  readonly digest: string
  readonly payload: Uint8Array
}

export class RemoteBackupError extends Data.TaggedError("RemoteBackupError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// RemoteBackup publishes complete host checkpoints and retrieves the latest published checkpoint.
export class RemoteBackup extends Context.Service<RemoteBackup, {
  readonly save: (checkpoint: HostCheckpoint) => Effect.Effect<void, RemoteBackupError>
  readonly latest: Effect.Effect<string | undefined, RemoteBackupError>
  readonly load: (id: string) => Effect.Effect<HostCheckpoint | undefined, RemoteBackupError>
}>()("experimental/RemoteBackup") {}

const backupError = (message: string, cause: unknown): RemoteBackupError => new RemoteBackupError({ message, cause })

// remoteBackupFromKeyValueStore stores each checkpoint before advertising its ID as complete.
export const remoteBackupFromKeyValueStore = (namespace: string): Layer.Layer<RemoteBackup, never, KeyValueStore.KeyValueStore> => {
  if (!namespace) throw new Error("backup namespace must not be empty")
  return Layer.effect(RemoteBackup, Effect.gen(function*() {
    const store = yield* KeyValueStore.KeyValueStore
    const latestKey = `${namespace}/latest`
    const checkpointKey = (id: string) => `${namespace}/checkpoint/${id}`
    return RemoteBackup.of({
      save: (checkpoint) => Effect.gen(function*() {
        const envelope = JSON.stringify({
          id: checkpoint.id,
          actor: checkpoint.actor,
          createdAt: checkpoint.createdAt,
          digest: checkpoint.digest
        })
        yield* store.set(`${checkpointKey(checkpoint.id)}/payload`, checkpoint.payload)
        yield* store.set(checkpointKey(checkpoint.id), envelope)
        yield* store.set(latestKey, checkpoint.id)
      }).pipe(Effect.mapError((cause) => backupError("checkpoint upload failed", cause))),
      latest: store.get(latestKey).pipe(Effect.mapError((cause) => backupError("checkpoint lookup failed", cause))),
      load: (id) => store.get(checkpointKey(id)).pipe(
        Effect.mapError((cause) => backupError("checkpoint download failed", cause)),
        Effect.flatMap((raw) => Effect.try({
          try: () => {
            if (raw === undefined) return undefined
            const value: unknown = JSON.parse(raw)
            if (typeof value !== "object" || value === null) throw new Error("invalid checkpoint envelope")
            const record = value as Record<string, unknown>
            if (record.id !== id || typeof record.actor !== "string" || typeof record.createdAt !== "number" ||
              typeof record.digest !== "string") throw new Error("invalid checkpoint envelope")
            return { id, actor: record.actor, createdAt: record.createdAt, digest: record.digest }
          },
          catch: (cause) => backupError("checkpoint envelope is invalid", cause)
        })),
        Effect.flatMap((metadata) => metadata === undefined ? Effect.sync(() => metadata) : store.getUint8Array(`${checkpointKey(id)}/payload`).pipe(
          Effect.mapError((cause) => backupError("checkpoint download failed", cause)),
          Effect.flatMap((payload) => payload === undefined
            ? Effect.fail(backupError("checkpoint payload is missing", id))
            : Effect.succeed({ ...metadata, payload }))
        ))
      )
    })
  }))
}
