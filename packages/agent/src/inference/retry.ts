import { Schema } from "effect"

import type { RequestPolicy } from "@clavia/tardigrade-model/stream/policy"
export { RequestPolicy, RetryPolicy } from "@clavia/tardigrade-model/stream/policy"

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
