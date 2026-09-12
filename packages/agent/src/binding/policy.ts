export interface StreamBounds {
  readonly firstContentMs: number
  readonly idleMs: number
  readonly attemptMs?: number | undefined
}

// DEFAULT_TIMEOUT bounds first content and idle gaps; the overall deadline is opt-in (request.test.ts).
export const DEFAULT_TIMEOUT: StreamBounds = { firstContentMs: 90_000, idleMs: 90_000 }
export const MAX_TIMER_DELAY_MS = 2_147_483_647
export const DEFAULT_BACKOFF_MS: ReadonlyArray<number> = [2_000, 8_000, 30_000]
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000
export const DEFAULT_RETRY_AFTER_JITTER_MS = 1_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
