import { Cause, Clock, Effect, Fiber, Layer, Schedule } from "effect"
import { Checkpoint, checkpointLayer } from "./checkpoint"
import { DEFAULT_CHECKPOINT_POLICY, RemoteBackup, RemoteBackupError, type CheckpointPolicy } from "./index"

export interface BunBackupOptions {
  readonly layer: Layer.Layer<RemoteBackup, Error>
  readonly schedule?: Schedule.Schedule<unknown>
  readonly retry?: Schedule.Schedule<unknown>
  readonly checkpoint?: Partial<CheckpointPolicy>
}

export const DEFAULT_BUN_BACKUP_SCHEDULE = Schedule.spaced("30 seconds")
export const DEFAULT_BUN_BACKUP_RETRY = Schedule.exponential("1 second")

export interface BunBackupStatus {
  readonly dirty: boolean
  readonly uploading: boolean
  readonly lastCompleted?: { readonly id: string; readonly at: number }
  readonly lastError?: string
}

// bunBackupRunner coalesces locally committed changes and retries failed uploads without delaying commits.
export const bunBackupRunner = (options: {
  readonly actor: string
  readonly storage: string
  readonly backup: BunBackupOptions
}) => {
  if (options.storage === ":memory:") throw new Error("memory storage cannot be backed up")
  const maxBytes = options.backup.checkpoint?.maxBytes ?? DEFAULT_CHECKPOINT_POLICY.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("checkpoint maxBytes must be a positive integer")
  const timeoutMs = options.backup.checkpoint?.captureTimeoutMs ?? DEFAULT_CHECKPOINT_POLICY.captureTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("checkpoint captureTimeoutMs must be a positive integer")
  let revision = 0
  let saved = 0
  let uploading = false
  let lastCompleted: BunBackupStatus["lastCompleted"]
  let lastError: string | undefined
  let fiber: Fiber.Fiber<unknown, unknown> | undefined
  let lastDigest: string | undefined
  const attempt = Effect.gen(function*() {
    const target = revision
    uploading = true
    const capture = yield* Checkpoint
    const checkpoint = yield* capture.capture({ actor: options.actor, storage: options.storage, maxBytes })
    if (checkpoint.digest === lastDigest) {
      saved = target
      lastError = undefined
      return
    }
    const backup = yield* RemoteBackup
    yield* backup.save(checkpoint).pipe(
      Effect.tapError((error) => Effect.sync(() => { lastError = error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message })),
      Effect.retry(options.backup.retry ?? DEFAULT_BUN_BACKUP_RETRY)
    )
    saved = target
    lastDigest = checkpoint.digest
    lastCompleted = { id: checkpoint.id, at: yield* Clock.currentTimeMillis }
    lastError = undefined
  }).pipe(Effect.tapError((error) => Effect.sync(() => { lastError = error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message })), Effect.ensuring(Effect.sync(() => { uploading = false })))
  const loop = Effect.repeat(
    attempt.pipe(
      Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.sync(() => { lastError = String(Cause.squash(cause)) }))
    ),
    options.backup.schedule ?? DEFAULT_BUN_BACKUP_SCHEDULE
  )
  return {
    markDirty: (): void => { revision += 1 },
    status: (): BunBackupStatus => ({
      dirty: revision !== saved,
      uploading,
      ...(lastCompleted === undefined ? {} : { lastCompleted }),
      ...(lastError === undefined ? {} : { lastError })
    }),
    start: (): void => { fiber ??= Effect.runFork(loop.pipe(
      Effect.provide(Layer.merge(checkpointLayer({ timeoutMs }), options.backup.layer.pipe(Layer.catch((cause) => Layer.effect(RemoteBackup, Effect.fail(new RemoteBackupError({ message: "backup layer failed", cause }))))))),
      Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.fail(new RemoteBackupError({ message: String(Cause.squash(cause)), cause }))),
      Effect.tapError((error) => Effect.sync(() => { lastError = String(error) })),
      Effect.retry(options.backup.retry ?? DEFAULT_BUN_BACKUP_RETRY)
    )) },
    close: async (): Promise<void> => {
      if (fiber !== undefined) await Effect.runPromise(Fiber.interrupt(fiber))
    }
  }
}
