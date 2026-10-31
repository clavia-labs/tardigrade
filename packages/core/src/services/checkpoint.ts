export { encodeActorCheckpointV4, LEGACY_ACTOR_CHECKPOINT_VERSION } from "./checkpoint/schema/actor-v4"
export * from "./checkpoint/manifest"
import { ACTOR_CHECKPOINT_VERSION, decodeActorCheckpointState } from "./checkpoint/schema/actor-v5"
export { ACTOR_CHECKPOINT_VERSION } from "./checkpoint/schema/actor-v5"
export * from "./checkpoint/atom"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { ActorReplayError, RuntimeError } from "../runtime/effects"
import type { EffectCheckpoint } from "../runtime/replay"
import { migrateCheckpoint, CheckpointReplayRequired } from "./checkpoint/migrations"
export { CheckpointReplayRequired } from "./checkpoint/migrations"

export const DEFAULT_CHECKPOINT_MAX_BYTES = 128 * 1024 * 1024

// checkpointDigestSync hashes the serialized bytes for synchronous journal validation (platform/test/properties/checkpoint/storage.ts).
export const checkpointDigestSync = (payload: Uint8Array): string => createHash("sha256").update(payload).digest("hex")

export const checkpointDigest = (payload: Uint8Array): Effect.Effect<string, RuntimeError> => Effect.try({ try: () => checkpointDigestSync(payload), catch: RuntimeError.from })

export const encodeCheckpoint = (checkpoint: EffectCheckpoint): Uint8Array => {
  const state = decodeActorCheckpointState(checkpoint)
  let encoded: string
  try {
    encoded = JSON.stringify({ version: ACTOR_CHECKPOINT_VERSION, ...state })
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
  return decodeActorCheckpointState(state)
}
