import { Clock, Context, Data, Effect, PubSub, type Schema, Stream } from "effect"
import type { ThreadCoordinate } from "../actor/thread"
import { RuntimeError, type EffectRef } from "../runtime/effects"

export interface ExecutionUpdatePayload {
  readonly type: string
  readonly [key: string]: Schema.Json
}

export interface ExecutionUpdate {
  readonly address?: ThreadCoordinate
  readonly ref: EffectRef
  readonly attemptId: string
  readonly sequence: number
  readonly payload: ExecutionUpdatePayload
}

export interface ExecutionStreamPolicy {
  readonly bufferCapacity: number
}

export const DEFAULT_EXECUTION_STREAM_POLICY: ExecutionStreamPolicy = { bufferCapacity: 64 }

export const DEFAULT_STREAM_TIMEOUT = { firstChunkMs: 60_000, idleMs: 60_000 } as const
export interface StreamTimeoutOptions {
  readonly firstChunkMs?: number | null
  readonly idleMs?: number | null
}

// StreamTimedOut identifies the expired transport gap without treating a partial stream as complete (platform/test/bun/execution-stream.test.ts).
export class StreamTimedOut extends Data.TaggedError("StreamTimedOut")<{ readonly bound: keyof typeof DEFAULT_STREAM_TIMEOUT; readonly timeoutMs: number }> {
  override get message() { return `Stream ${this.bound} timed out after ${this.timeoutMs}ms` }
}

// withStreamTimeout bounds the first upstream chunk and subsequent gaps; null disables an individual bound (platform/test/bun/execution-stream.test.ts).
export const withStreamTimeout = <Value, Failure, Services>(stream: Stream.Stream<Value, Failure, Services>, options: StreamTimeoutOptions = {}) => Stream.transformPull(stream, pull => Clock.currentTimeMillis.pipe(Effect.flatMap(startedAt => {
  const bounds = { firstChunkMs: options.firstChunkMs === undefined ? DEFAULT_STREAM_TIMEOUT.firstChunkMs : options.firstChunkMs, idleMs: options.idleMs === undefined ? DEFAULT_STREAM_TIMEOUT.idleMs : options.idleMs }
  for (const [name, value] of Object.entries(bounds)) if (value !== null && (!Number.isSafeInteger(value) || value < 1)) return Effect.fail(new RuntimeError(`${name} must be a positive safe integer or null`))
  let first = true
  let lastChunkAt = startedAt
  return Effect.succeed(Effect.gen(function* () {
    const bound = first ? "firstChunkMs" : "idleMs"
    const timeoutMs = bounds[bound]
    const next = timeoutMs === null ? pull : Clock.currentTimeMillis.pipe(Effect.flatMap(now => {
      const remaining = timeoutMs - (now - lastChunkAt)
      const expired = () => Effect.fail(new StreamTimedOut({ bound, timeoutMs }))
      return remaining <= 0 ? expired() : pull.pipe(Effect.timeoutOrElse({ duration: remaining, orElse: expired }))
    }))
    const values = yield* next
    first = false
    lastChunkAt = yield* Clock.currentTimeMillis
    return values
  }))
})))

// ExecutionStream broadcasts ephemeral execution updates within a host lifetime (packages/platform/test/bun/execution-stream.test.ts).
export class ExecutionStream extends Context.Service<ExecutionStream, {
  readonly policy: ExecutionStreamPolicy
  readonly stream: Stream.Stream<ExecutionUpdate>
  readonly publish: (update: ExecutionUpdate) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
}>()("tardigrade/ExecutionStream") {}

// createExecutionStream retains recent updates for active subscribers without blocking publishers (packages/platform/test/bun/execution-stream.test.ts).
export const createExecutionStream = (options: Partial<ExecutionStreamPolicy> = {}): Effect.Effect<typeof ExecutionStream.Service, RuntimeError> => Effect.gen(function* () {
  const policy = { ...DEFAULT_EXECUTION_STREAM_POLICY, ...options }
  if (!Number.isSafeInteger(policy.bufferCapacity) || policy.bufferCapacity < 1) return yield* Effect.fail(new RuntimeError("ExecutionStream bufferCapacity must be a positive safe integer"))
  const bus = yield* PubSub.sliding<ExecutionUpdate>(policy.bufferCapacity)
  return {
    policy,
    stream: Stream.fromPubSub(bus),
    publish: update => PubSub.publish(bus, update).pipe(Effect.asVoid),
    close: PubSub.shutdown(bus),
  }
})
