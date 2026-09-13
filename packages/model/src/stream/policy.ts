import { Schema } from "effect"

export interface StreamBounds {
  readonly firstChunkMs: number
  readonly idleMs: number
  readonly attemptMs?: number | undefined
}

// DEFAULT_TIMEOUT bounds the first adapter chunk and idle gaps; the overall deadline is opt-in (request.test.ts).
export const DEFAULT_TIMEOUT: StreamBounds = { firstChunkMs: 90_000, idleMs: 90_000 }
export const MAX_TIMER_DELAY_MS = 2_147_483_647
export const DEFAULT_BACKOFF_MS: ReadonlyArray<number> = [2_000, 8_000, 30_000]
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000
export const DEFAULT_RETRY_AFTER_JITTER_MS = 1_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768

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
