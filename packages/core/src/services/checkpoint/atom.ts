import { Schema } from "effect"
import { ATOM_CHECKPOINT_VERSION, AtomCheckpointState, AtomCheckpointPayload } from "./schema/atom-v1"
export { ATOM_CHECKPOINT_VERSION } from "./schema/atom-v1"
export { atomCheckpointKey } from "./schema/reference"

export interface AtomCheckpointIdentity {
  readonly name: string
  readonly family?: string
  readonly version?: string
}

export interface AtomCheckpoint extends AtomCheckpointIdentity {
  readonly position: number
  readonly state: unknown
}

export type ReadAtomCheckpoint = (identity: AtomCheckpointIdentity, position: number) => AtomCheckpoint | undefined

const decode = Schema.decodeUnknownSync(AtomCheckpointState, { onExcessProperty: "error" })
const decodePayload = Schema.decodeUnknownSync(AtomCheckpointPayload, { onExcessProperty: "error" })

export const encodeAtomCheckpoint = (checkpoint: AtomCheckpoint): Uint8Array => new TextEncoder().encode(JSON.stringify({ version: ATOM_CHECKPOINT_VERSION, checkpoint: decode(checkpoint) }))

export const decodeAtomCheckpoint = (payload: Uint8Array): AtomCheckpoint => {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload))
  return decodePayload(value).checkpoint
}
