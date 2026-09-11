export interface StreamBounds {
  readonly firstChunkMs: number
  readonly idleMs: number
  readonly totalMs?: number
}

// DEFAULT_STREAM_BOUNDS bounds first output and idle gaps; total duration is opt-in (inference/request.test.ts).
export const DEFAULT_STREAM_BOUNDS: StreamBounds = {
  firstChunkMs: 90_000,
  idleMs: 90_000
}

// MAX_TIMER_DELAY_MS is the largest delay Bun accepts without clamping it to 1ms
// (inference/request.test.ts).
export const MAX_TIMER_DELAY_MS = 2_147_483_647

// DEFAULT_THROTTLE_RETRY_DELAYS_MS supplies the backoff bases for transient provider failures.
// Its length bounds the retry count, and callers can replace it through ModelConfig.
export const DEFAULT_THROTTLE_RETRY_DELAYS_MS: ReadonlyArray<number> = [2_000, 8_000, 30_000]

// DEFAULT_RETRY_AFTER_JITTER_MS supplies the jitter base added to a provider's stated wait.
export const DEFAULT_RETRY_AFTER_JITTER_MS = 1_000


// DEFAULT_MAX_OUTPUT_TOKENS limits output when the caller supplies no limit (inference/request.test.ts).
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
