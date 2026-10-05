import type { RetryPolicy } from "./policy"

// retryDelayOf honors provider waits within the configured retry budget (packages/platform/test/bun/model-retry.test.ts).
export const retryDelayOf = (policy: RetryPolicy, index: number, retryAfterMs: number | undefined, random: number): number | undefined => {
  const base = policy.backoffMs[index]
  if (base === undefined || (retryAfterMs !== undefined && retryAfterMs > policy.maxRetryAfterMs)) return undefined
  return Math.ceil(retryAfterMs === undefined ? random * base : retryAfterMs + random * policy.retryAfterJitterMs)
}
