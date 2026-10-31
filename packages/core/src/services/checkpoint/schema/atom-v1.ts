import { Schema } from "effect"
import { AtomCheckpointReference, CompleteCheckpointIdentity } from "./reference"

export const ATOM_CHECKPOINT_VERSION = 1
export const AtomCheckpointState = Schema.Struct({ ...AtomCheckpointReference.fields, state: Schema.Json }).check(CompleteCheckpointIdentity)
export const AtomCheckpointPayload = Schema.Struct({ version: Schema.Literal(ATOM_CHECKPOINT_VERSION), checkpoint: AtomCheckpointState })
