// RUNTIME_PROPERTY_OPTIONS supplies reproducible generation settings shared by platform runners.
export const RUNTIME_PROPERTY_OPTIONS = { seed: 20260930, numRuns: 100 } as const

// RUNTIME_PROPERTY_TEST_TIMEOUT_MS bounds the complete generated property, including crash and reopen sequences.
export const RUNTIME_PROPERTY_TEST_TIMEOUT_MS = 30_000
