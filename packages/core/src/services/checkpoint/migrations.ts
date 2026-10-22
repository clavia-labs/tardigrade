// CheckpointReplayRequired requests recovery from the journal for checkpoint formats that contain operation state (platform/test/properties/runtime/pending-input-recovery.ts).
export class CheckpointReplayRequired extends Error {
  readonly _tag = "CheckpointReplayRequired"
  constructor(readonly version: number) {
    super(`Checkpoint version ${version} requires full journal replay`)
  }
}

// migrateCheckpoint accepts the actor-state format and requests journal replay for legacy formats.
export function migrateCheckpoint(record: Record<string, unknown>): Record<string, unknown> {
  if (record.version === 4) return record
  if (record.version === 2 || record.version === 3) throw new CheckpointReplayRequired(record.version)
  throw new Error("Invalid checkpoint payload")
}
