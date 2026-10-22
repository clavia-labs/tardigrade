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

export const encodeCheckpoint = (checkpoint: EffectCheckpoint): Uint8Array => {
  if (Object.keys(checkpoint).some(key => key !== "position" && key !== "durable")) throw new Error("Invalid checkpoint fields")
  if (!Number.isSafeInteger(checkpoint.position) || checkpoint.position < 0) throw new Error("Invalid checkpoint position")
  if (checkpoint.durable.some(entry => entry.position !== checkpoint.position)) throw new Error("Durable entry position differs from checkpoint position")
  if (checkpoint.durable.some(entry => !Schema.is(Schema.Json)(entry.state))) throw new Error("Checkpoint state must be JSON")
  let encoded: string
  try {
    encoded = JSON.stringify({ version: 4, position: checkpoint.position, durable: checkpoint.durable })
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
  const record = migrateCheckpoint(value as Record<string, unknown>)
  if (!Number.isSafeInteger(record.position) || (record.position as number) < 0 ||
    !Array.isArray(record.durable)) throw new Error("Invalid checkpoint payload")
  const durable = record.durable.map(entry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Invalid durable checkpoint entry")
    const item = entry as Record<string, unknown>
    if (typeof item.name !== "string" || !item.name || !Number.isSafeInteger(item.position) || (item.position as number) < 0 || item.state === undefined) throw new Error("Invalid durable checkpoint entry")
    if (item.position !== record.position) throw new Error("Durable entry position differs from checkpoint position")
    return { name: item.name, state: item.state, position: item.position as number }
  })
  if (Object.keys(record).some(key => key !== "version" && key !== "position" && key !== "durable")) throw new Error("Invalid checkpoint fields")
  return { position: record.position as number, durable }
}
