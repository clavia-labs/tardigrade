export const DIRECTORY_ORACLE_DEFAULTS = {
  smallThreads: 128,
  largeThreads: 2048,
  payloadBytes: 96 * 1024,
  pendingThreads: 2,
  seedBatchSize: 16,
  lookupCount: 256,
  freshThreads: 8,
  sampleIntervalMs: 10,
  requestTimeoutMs: 120_000,
  pollIntervalMs: 25,
  maxPeakBytes: 96 * 1024 * 1024,
  maxRetainedBytes: 32 * 1024 * 1024,
  maxRetainedGrowthBytes: 8 * 1024 * 1024,
  maxBackingBytes: 32 * 1024 * 1024,
} as const

export const DIRECTORY_ORACLE_ACTOR = "directory-oracle"
export const DIRECTORY_ORACLE_INSTANCE = "oracle"

export interface JournalStats {
  readonly records: number
  readonly bytes: number
  readonly digest: string
}
