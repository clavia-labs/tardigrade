import { Schema } from "effect"
import type { EffectCheckpoint } from "../../../runtime/replay"
import { AtomCheckpointState } from "./atom-v1"
import { CheckpointPosition } from "./position"
import { validateCheckpointReferences } from "./reference"

export const ACTOR_CHECKPOINT_VERSION = 5
const State = Schema.Struct({ position: CheckpointPosition, durable: Schema.Array(AtomCheckpointState) })
const decode = Schema.decodeUnknownSync(State, { onExcessProperty: "error" })

// decodeActorCheckpointState validates independently positioned atom snapshots within an actor prefix (platform/test/properties/checkpoint/safety.ts).
export function decodeActorCheckpointState(value: unknown): EffectCheckpoint {
  const checkpoint = decode(value)
  validateCheckpointReferences(checkpoint.position, checkpoint.durable, ACTOR_CHECKPOINT_VERSION)
  return checkpoint
}
