import { CheckpointPosition } from "./position"
import { AtomCheckpointReference, CompleteCheckpointIdentity, validateCheckpointReferences } from "./reference"
import { Schema } from "effect"
import type { EffectCheckpoint } from "../../../runtime/replay"

export const LEGACY_ACTOR_CHECKPOINT_VERSION = 4
const State = Schema.Struct({
  position: CheckpointPosition,
  durable: Schema.Array(Schema.Struct({
    name: AtomCheckpointReference.fields.name,
    state: Schema.Json,
    position: CheckpointPosition,
  }).check(CompleteCheckpointIdentity)),
})
const decode = Schema.decodeUnknownSync(State, { onExcessProperty: "error" })

// decodeActorCheckpointState validates the recovery boundary shared by regular atoms (platform/test/properties/checkpoint/schema.ts).
export function decodeActorCheckpointState(value: unknown): EffectCheckpoint {
  const checkpoint = decode(value)
  validateCheckpointReferences(checkpoint.position, checkpoint.durable, LEGACY_ACTOR_CHECKPOINT_VERSION)
  return checkpoint
}

export const encodeActorCheckpointV4 = (checkpoint: EffectCheckpoint): Uint8Array => new TextEncoder().encode(JSON.stringify({ version: LEGACY_ACTOR_CHECKPOINT_VERSION, ...decodeActorCheckpointState(checkpoint) }))
