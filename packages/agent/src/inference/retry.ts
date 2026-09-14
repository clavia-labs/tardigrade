import { Schema } from "effect"
import { modelErrorOf } from "./error"
import { ModelRef } from "./reference"
import type { Action } from "../log/events"

import type { RequestPolicy } from "@clavia/tardigrade-model/stream/policy"
export { RequestPolicy, RetryPolicy } from "@clavia/tardigrade-model/stream/policy"

// RetrySchedule records the next attempt's wake time, retry index, and optional model switch (retry.test.ts, fallback.test.ts).
export const RetrySchedule = Schema.Struct({
  dueAt: Schema.Finite,
  model: Schema.optional(ModelRef),
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export type RetrySchedule = typeof RetrySchedule.Type

// retryDelayOf honors provider waits within the configured limit (retry.test.ts).
export const retryDelayOf = (policy: RequestPolicy, index: number, retryAfterMs: number | undefined, random: number): number | undefined => {
  const base = policy.retry.backoffMs[index]
  if (base === undefined || (retryAfterMs !== undefined && retryAfterMs > policy.retry.maxRetryAfterMs)) return undefined
  return Math.ceil(retryAfterMs === undefined ? random * base : retryAfterMs + random * policy.retry.retryAfterJitterMs)
}

// canFallback admits provider failures while leaving local contract failures terminal (fallback.test.ts).
export const canFallback = (action: Action): boolean => {
  if (action.kind !== "fail" || (action.failure?.cause !== undefined && action.failure.cause !== "inference_error")) return false
  if (action.retryable === true) return true
  const error = modelErrorOf(action.error)
  if (error === undefined) return false
  const reason = error.reason
  switch (reason._tag) {
    case "AuthenticationError":
    case "QuotaExhaustedError":
    case "InvalidRequestError":
      return true
    default:
      return false
  }
}
