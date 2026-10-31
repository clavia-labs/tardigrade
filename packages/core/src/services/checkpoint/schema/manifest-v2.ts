import { Schema } from "effect"
import { ACTOR_CHECKPOINT_VERSION } from "./actor-v5"
import { LEGACY_ACTOR_CHECKPOINT_VERSION } from "./actor-v4"
import { CheckpointPosition } from "./position"
import { AtomCheckpointReference } from "./reference"

export const CHECKPOINT_MANIFEST_VERSION = 2
export const CheckpointManifest = Schema.Struct({ version: Schema.Literal(CHECKPOINT_MANIFEST_VERSION), checkpointVersion: Schema.Literals([LEGACY_ACTOR_CHECKPOINT_VERSION, ACTOR_CHECKPOINT_VERSION]), position: CheckpointPosition, atoms: Schema.Array(AtomCheckpointReference) })
