import { Schema } from "effect"
import type { EffectCheckpoint } from "../../runtime/replay"
import { validateCheckpointReferences } from "./schema/reference"
import { ACTOR_CHECKPOINT_VERSION } from "./schema/actor-v5"
import { LEGACY_ACTOR_CHECKPOINT_VERSION } from "./schema/actor-v4"
import { LEGACY_CHECKPOINT_MANIFEST_VERSION, LegacyCheckpointManifest } from "./schema/manifest-v1"
import { CHECKPOINT_MANIFEST_VERSION, CheckpointManifest } from "./schema/manifest-v2"

const decodeSchema = Schema.decodeUnknownSync(CheckpointManifest, { onExcessProperty: "error" })
const decode = (value: unknown) => {
  const manifest = decodeSchema(value)
  validateCheckpointReferences(manifest.position, manifest.atoms, manifest.checkpointVersion)
  return manifest
}

export const encodeCheckpointManifest = (checkpoint: EffectCheckpoint, checkpointVersion: 4 | 5 = ACTOR_CHECKPOINT_VERSION): Uint8Array => new TextEncoder().encode(JSON.stringify(decode({ version: CHECKPOINT_MANIFEST_VERSION, checkpointVersion, position: checkpoint.position, atoms: checkpoint.durable.map(({ state: _state, ...reference }) => reference) })))

export const decodeCheckpointManifest = (payload: Uint8Array) => {
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload))
  if (typeof raw === "object" && raw !== null && "version" in raw && raw.version === LEGACY_CHECKPOINT_MANIFEST_VERSION) {
    const legacy = Schema.decodeUnknownSync(LegacyCheckpointManifest, { onExcessProperty: "error" })(raw)
    return decode({ version: CHECKPOINT_MANIFEST_VERSION, checkpointVersion: LEGACY_ACTOR_CHECKPOINT_VERSION, position: legacy.position, atoms: legacy.atoms.map(name => ({ name, position: legacy.position })) })
  }
  return decode(raw)
}
