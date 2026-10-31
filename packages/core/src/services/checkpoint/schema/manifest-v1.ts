import { Schema } from "effect"
import { CheckpointPosition } from "./position"

export const LEGACY_CHECKPOINT_MANIFEST_VERSION = 1
export const LegacyCheckpointManifest = Schema.Struct({ version: Schema.Literal(LEGACY_CHECKPOINT_MANIFEST_VERSION), position: CheckpointPosition, atoms: Schema.Array(Schema.String) })
