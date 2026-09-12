import { Schema } from "effect"

export const RetryPolicy = Schema.Struct({
  backoffMs: Schema.Array(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  maxRetryAfterMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  retryAfterJitterMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
})
export type RetryPolicy = typeof RetryPolicy.Type

export const RequestPolicy = Schema.Struct({
  maxOutputTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  timeout: Schema.Struct({
    firstChunkMs: Schema.Finite.check(Schema.isGreaterThan(0)),
    idleMs: Schema.Finite.check(Schema.isGreaterThan(0)),
    attemptMs: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0)))
  }),
  retry: RetryPolicy
})
export type RequestPolicy = typeof RequestPolicy.Type

// RetrySchedule records a chosen wake time and the number of retries already scheduled (retry.test.ts).
export const RetrySchedule = Schema.Struct({
  dueAt: Schema.Finite,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export type RetrySchedule = typeof RetrySchedule.Type

// retryDelayOf honors provider waits within the configured limit (retry.test.ts).
export const retryDelayOf = (policy: RequestPolicy, index: number, retryAfterMs: number | undefined, random: number): number | undefined => {
  const base = policy.retry.backoffMs[index]
  if (base === undefined || (retryAfterMs !== undefined && retryAfterMs > policy.retry.maxRetryAfterMs)) return undefined
  return Math.ceil(retryAfterMs === undefined ? random * base : retryAfterMs + random * policy.retry.retryAfterJitterMs)
}
