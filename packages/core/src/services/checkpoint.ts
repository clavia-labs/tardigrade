import { Schema, Effect } from "effect"
import { createHash } from "node:crypto"
import { ActorReplayError, RuntimeError } from "../runtime/effects"
import type { EffectCheckpoint } from "../runtime/replay"
import { migrateCheckpoint, CheckpointReplayRequired } from "./checkpoint/migrations"
export { CheckpointReplayRequired } from "./checkpoint/migrations"

export const DEFAULT_CHECKPOINT_MAX_BYTES = 256 * 1024 * 1024

// checkpointDigestSync hashes the serialized bytes for synchronous journal validation (platform/test/properties/checkpoint-storage.ts).
export const checkpointDigestSync = (payload: Uint8Array): string => createHash("sha256").update(payload).digest("hex")

export const checkpointDigest = (payload: Uint8Array): Effect.Effect<string, RuntimeError> => Effect.try({ try: () => checkpointDigestSync(payload), catch: RuntimeError.from })

const Position = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const CheckpointState = Schema.Struct({
  position: Position,
  durable: Schema.Array(Schema.Struct({
    name: Schema.String.check(Schema.makeFilter(name => name.trim().length > 0, { title: "Durable atom name is nonempty" })),
    state: Schema.Json,
    position: Position,
  })),
})
const decodeState = Schema.decodeUnknownSync(CheckpointState, { onExcessProperty: "error" })

// validateCheckpoint applies the actor-state contract to both codec directions (platform/test/properties/checkpoint-storage.ts).
function validateCheckpoint(value: unknown): EffectCheckpoint {
  const checkpoint = decodeState(value)
  if (checkpoint.durable.some(entry => entry.position !== checkpoint.position)) throw new Error("Durable entry position differs from checkpoint position")
  return checkpoint
}

export const encodeCheckpoint = (checkpoint: EffectCheckpoint): Uint8Array => {
  const state = validateCheckpoint(checkpoint)
  let encoded: string
  try {
    encoded = JSON.stringify({ version: 4, ...state })
  } catch (cause) {
    throw new Error("Checkpoint state is not serializable", { cause })
  }
  return new TextEncoder().encode(encoded)
}

export const decodeCheckpoint = (payload: Uint8Array): EffectCheckpoint => {
  try { return checkpointFromJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload))) }
  catch (cause) {
    if (cause instanceof CheckpointReplayRequired) throw cause
    throw ActorReplayError.wrap(cause, { stage: "checkpoint", reason: "decode_failed" })
  }
}

function checkpointFromJson(value: unknown): EffectCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid checkpoint payload")
  const { version: _version, ...state } = migrateCheckpoint(value as Record<string, unknown>)
  return validateCheckpoint(state)
}
