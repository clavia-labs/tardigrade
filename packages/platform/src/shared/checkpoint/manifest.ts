import { ACTOR_CHECKPOINT_VERSION, LEGACY_ACTOR_CHECKPOINT_VERSION, decodeCheckpoint, encodeCheckpoint, encodeActorCheckpointV4, encodeCheckpointManifest, checkpointDigestSync, type AtomCheckpoint, type StoredCheckpoint } from "@clavia/tardigrade-core"

// splitActorCheckpoint references independently positioned regular and family snapshots (test/properties/checkpoint/e2e.ts).
export function splitActorCheckpoint(checkpoint: StoredCheckpoint): { readonly payload: Uint8Array; readonly atoms: readonly AtomCheckpoint[]; readonly encoding: 0 | 1 } {
  let value: unknown
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(checkpoint.payload)) } catch { return { payload: checkpoint.payload, atoms: [], encoding: 0 } }
  if (typeof value !== "object" || value === null || !("version" in value) || (value.version !== ACTOR_CHECKPOINT_VERSION && value.version !== LEGACY_ACTOR_CHECKPOINT_VERSION)) return { payload: checkpoint.payload, atoms: [], encoding: 0 }
  const decoded = decodeCheckpoint(checkpoint.payload)
  const canonical = value.version === LEGACY_ACTOR_CHECKPOINT_VERSION ? encodeActorCheckpointV4(decoded) : encodeCheckpoint(decoded)
  if (decoded.position !== checkpoint.position || checkpointDigestSync(canonical) !== checkpoint.digest) return { payload: checkpoint.payload, atoms: [], encoding: 0 }
  return { payload: encodeCheckpointManifest(decoded, value.version), atoms: decoded.durable, encoding: 1 }
}
