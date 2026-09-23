import { BunWorker } from "@effect/platform-bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Context, Data, Effect, Exit, Layer, Scope, Semaphore } from "effect"
import { RpcClient, RpcClientError } from "effect/unstable/rpc"
import { type HostCheckpoint } from "./index"
import { CheckpointRpcs } from "./protocol"

export interface CaptureRequest {
  readonly actor: string
  readonly storage: string
  readonly maxBytes: number
}

export class CheckpointError extends Data.TaggedError("CheckpointError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// Checkpoint captures local state without running snapshot work on the host thread (checkpoint.test.ts).
export class Checkpoint extends Context.Service<Checkpoint, {
  readonly capture: (request: CaptureRequest) => Effect.Effect<HostCheckpoint, CheckpointError>
}>()("tardigrade/bun/Checkpoint") {}

interface Session {
  readonly scope: Scope.Closeable
  readonly workers: Set<Worker>
  client?: RpcClient.FromGroup<typeof CheckpointRpcs, RpcClientError.RpcClientError>
}

// checkpointLayer owns a worker and replaces it after failed or interrupted captures (checkpoint.test.ts).
export const checkpointLayer = (options: {
  readonly timeoutMs: number
  readonly spawn?: () => Worker
}): Layer.Layer<Checkpoint> => Layer.effect(Checkpoint, Effect.gen(function*() {
  const semaphore = yield* Semaphore.make(1)
  let session: Session | undefined
  const stop = Effect.suspend(() => {
    const previous = session
    session = undefined
    if (previous === undefined) return Effect.void
    for (const worker of previous.workers) worker.terminate()
    return Scope.close(previous.scope, Exit.void)
  })
  yield* Effect.addFinalizer(() => stop)

  const client = Effect.gen(function*() {
    if (session?.client !== undefined) return session.client
    const current: Session = { scope: yield* Scope.make(), workers: new Set() }
    session = current
    const protocol = RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
      Layer.provide(BunWorker.layer(() => {
        const worker = options.spawn?.() ?? new Worker(new URL("./checkpoint-worker.ts", import.meta.url))
        current.workers.add(worker)
        worker.addEventListener("close", () => current.workers.delete(worker), { once: true })
        return worker
      }))
    )
    const context = yield* Layer.buildWithScope(protocol, current.scope)
    const result = yield* RpcClient.make(CheckpointRpcs).pipe(Effect.provideContext(context), Scope.provide(current.scope))
    current.client = result
    return result
  })

  return Checkpoint.of({
    capture: (request) => semaphore.withPermit(Effect.scoped(Effect.gen(function*() {
      const temporary = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "tardigrade-checkpoint-")), catch: (cause) => new CheckpointError({ message: "checkpoint temporary directory failed", cause }) }),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
      )
      return yield* Effect.gen(function*() {
        const rpc = yield* client
        return yield* rpc.capture({ ...request, temporary })
      }).pipe(
        Effect.timeoutOrElse({ duration: options.timeoutMs, orElse: () => Effect.fail(new CheckpointError({ message: `checkpoint capture exceeded ${options.timeoutMs}ms` })) }),
        Effect.onExit((exit) => Exit.isFailure(exit) ? stop : Effect.void),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
          const error = Cause.squash(cause)
          return Effect.fail(error instanceof CheckpointError ? error : new CheckpointError({ message: `checkpoint capture failed: ${error instanceof Error ? error.message : String(error)}`, cause: error }))
        })
      )
    })))
  })
}))
