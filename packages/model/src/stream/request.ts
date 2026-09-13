import { Clock, Data, Effect, Stream } from "effect"
import { DEFAULT_TIMEOUT, DEFAULT_BACKOFF_MS, DEFAULT_MAX_RETRY_AFTER_MS, DEFAULT_RETRY_AFTER_JITTER_MS, MAX_TIMER_DELAY_MS, DEFAULT_MAX_OUTPUT_TOKENS, type StreamBounds } from "./policy"

import type { RequestPolicy } from "./policy"
export type { RequestPolicy } from "./policy"

export type RequestOptions = {
  readonly maxOutputTokens?: number
  readonly timeout?: Partial<StreamBounds>
  readonly retry?: Partial<RequestPolicy["retry"]>
}

// requestPolicyOf resolves current host settings before an attempt starts.
export const requestPolicyOf = (options: RequestOptions): RequestPolicy => {
  if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0)) throw new Error("maxOutputTokens must be a positive safe integer")
  const policy = {
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    timeout: { ...DEFAULT_TIMEOUT, ...options.timeout },
    retry: {
      backoffMs: options.retry?.backoffMs ?? DEFAULT_BACKOFF_MS,
      maxRetryAfterMs: options.retry?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
      retryAfterJitterMs: options.retry?.retryAfterJitterMs ?? DEFAULT_RETRY_AFTER_JITTER_MS
    }
  }
  for (const [name, value] of Object.entries(policy.timeout)) {
    if (name === "attemptMs" && value === undefined) continue
    if (value === undefined || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) throw new Error(`timeout ${name} must be positive and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  for (const value of [...policy.retry.backoffMs, policy.retry.maxRetryAfterMs, policy.retry.retryAfterJitterMs]) {
    if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_DELAY_MS) throw new Error(`retry delay must be nonnegative and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (policy.retry.maxRetryAfterMs + policy.retry.retryAfterJitterMs > MAX_TIMER_DELAY_MS) throw new Error(`retry delay plus jitter must not exceed ${MAX_TIMER_DELAY_MS}`)
  return policy
}

export class StreamTruncated extends Data.TaggedError("StreamTruncated")<{ readonly maxOutputTokens: number }> {}

export class StreamIncomplete extends Data.TaggedError("StreamIncomplete") {
  readonly message = "Model stream ended before provider completion"
}

export class StreamBoundExceeded extends Data.TaggedError("StreamBoundExceeded")<{ readonly bound: keyof StreamBounds }> {}

// boundedStream interrupts stalled pulls without turning a timeout into successful completion (inference/request.test.ts).
export const boundedStream = <A, E, R>(stream: Stream.Stream<A, E, R>, bounds: StreamBounds) => Stream.transformPull(stream, (pull) => Clock.currentTimeMillis.pipe(Effect.map((startedAt) => {
  let first = true
  let lastChunkAt = startedAt
  return Effect.suspend(() => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const bound = first ? "firstChunkMs" : "idleMs"
    const remaining = bounds[bound] - (now - lastChunkAt)
    if (remaining <= 0) return yield* new StreamBoundExceeded({ bound })
    const values = yield* pull.pipe(Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.fail(new StreamBoundExceeded({ bound })) }))
    first = false
    lastChunkAt = yield* Clock.currentTimeMillis
    return values
  }))
})))
