import { Clock, Data, Duration, Effect, Random, Result, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import { DEFAULT_STREAM_BOUNDS, DEFAULT_THROTTLE_RETRY_DELAYS_MS, DEFAULT_RETRY_AFTER_JITTER_MS, MAX_TIMER_DELAY_MS, DEFAULT_MAX_OUTPUT_TOKENS, type StreamBounds } from "./policy"

export interface RequestPolicy {
  readonly maxOutputTokens: number
  readonly stream: StreamBounds
  readonly throttleRetryDelaysMs: ReadonlyArray<number>
  readonly retryAfterJitterMs: number
}

export type RequestOptions = {
  readonly maxOutputTokens?: number
  readonly stream?: Partial<StreamBounds>
  readonly throttleRetryDelaysMs?: ReadonlyArray<number>
  readonly retryAfterJitterMs?: number
}

// requestPolicyOf resolves and checks caller-owned bounds before a request starts.
export const requestPolicyOf = (options: RequestOptions): RequestPolicy => {
  if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0)) throw new Error("maxOutputTokens must be a positive safe integer")
  const policy = {
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream: { ...DEFAULT_STREAM_BOUNDS, ...options.stream },
    throttleRetryDelaysMs: options.throttleRetryDelaysMs ?? DEFAULT_THROTTLE_RETRY_DELAYS_MS,
    retryAfterJitterMs: options.retryAfterJitterMs ?? DEFAULT_RETRY_AFTER_JITTER_MS
  }
  for (const [name, value] of Object.entries(policy.stream)) {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) throw new Error(`stream ${name} must be positive and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  for (const value of [...policy.throttleRetryDelaysMs, policy.retryAfterJitterMs]) {
    if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_DELAY_MS) throw new Error(`retry delay must be nonnegative and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (Math.max(0, ...policy.throttleRetryDelaysMs) + policy.retryAfterJitterMs > MAX_TIMER_DELAY_MS) throw new Error(`retry delay plus jitter must not exceed ${MAX_TIMER_DELAY_MS}`)
  return policy
}

export class StreamTruncated extends Data.TaggedError("StreamTruncated")<{ readonly maxOutputTokens: number }> {}

export class StreamIncomplete extends Data.TaggedError("StreamIncomplete") {
  readonly message = "Model stream ended before provider completion"
}

export class StreamBoundExceeded extends Data.TaggedError("StreamBoundExceeded")<{ readonly bound: keyof StreamBounds }> {}
export class RequestFailed extends Data.TaggedError("RequestFailed")<{ readonly cause: unknown; readonly attempts: number; readonly policy: RequestPolicy }> {}

// boundedStream interrupts stalled pulls without turning a timeout into successful completion (inference/request.test.ts).
export const boundedStream = <A, E, R>(stream: Stream.Stream<A, E, R>, bounds: StreamBounds, isProgress: (value: A) => boolean = () => true) => Stream.transformPull(stream, (pull) => Clock.currentTimeMillis.pipe(Effect.map((startedAt) => {
  let first = true
  let progressAt = startedAt
  return Effect.suspend(() => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const bound = first ? "firstChunkMs" : "idleMs"
    const remaining = bounds[bound] - (now - progressAt)
    if (remaining <= 0) return yield* new StreamBoundExceeded({ bound })
    const values = yield* pull.pipe(Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.fail(new StreamBoundExceeded({ bound })) }))
    if (values.some(isProgress)) {
      first = false
      progressAt = yield* Clock.currentTimeMillis
    }
    return values
  }))
})))

// retryRequest retries complete attempts using Effect's provider classification (inference/request.test.ts).
export const retryRequest = <A, E, R>(attempt: (maxOutputTokens: number) => Effect.Effect<A, E, R>, policy: RequestPolicy) => Effect.gen(function* () {
  let waits = 0
  for (let index = 0; ; index++) {
    const result = yield* Effect.result(attempt(policy.maxOutputTokens))
    if (Result.isSuccess(result)) return result.success
    const error = result.failure
    const retryable = error instanceof StreamIncomplete || error instanceof StreamBoundExceeded || (AiError.isAiError(error) && error.isRetryable)
    const base = policy.throttleRetryDelaysMs[waits]
    const stated = AiError.isAiError(error) && error.retryAfter !== undefined ? Duration.toMillis(error.retryAfter) : undefined
    const ceiling = policy.throttleRetryDelaysMs.at(-1) ?? 0
    if (!retryable || base === undefined || (stated !== undefined && stated > ceiling)) return yield* new RequestFailed({ cause: error, attempts: index + 1, policy })
    waits++
    const random = yield* Random.next
    yield* Effect.sleep(stated === undefined ? random * base : stated + random * policy.retryAfterJitterMs)
  }
})
