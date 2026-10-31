import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { checkpointDigestSync, decodeAtomCheckpoint, encodeAtomCheckpoint, RuntimeError, type AtomCheckpoint, type AtomCheckpointIdentity, atomCheckpointKey } from "@clavia/tardigrade-core"
import { encodeCheckpointChunks, decodeCheckpointChunks, type CheckpointChunk } from "./chunks"

interface AtomRow {
  readonly id: number
  readonly position: number
  readonly byte_length: number
  readonly chunk_count: number
  readonly digest: string
}

const find = (sql: SqlClient.SqlClient, identity: AtomCheckpointIdentity, position: number) => identity.family === undefined
  ? sql<AtomRow>`SELECT id, position, byte_length, chunk_count, digest FROM atom_checkpoints WHERE name = ${identity.name} AND family IS NULL AND position <= ${position} ORDER BY position DESC LIMIT 1`
  : sql<AtomRow>`SELECT id, position, byte_length, chunk_count, digest FROM atom_checkpoints WHERE name = ${identity.name} AND family = ${identity.family} AND version = ${identity.version} AND position <= ${position} ORDER BY position DESC LIMIT 1`

// collectAtomCheckpoints retains the latest snapshot and snapshots pinned by the actor manifest (test/properties/checkpoint/storage-safety.ts).
export const collectAtomCheckpoints = (sql: SqlClient.SqlClient, identity?: AtomCheckpointIdentity) => Effect.gen(function* () {
  const scope = identity === undefined ? sql`` : identity.family === undefined
    ? sql`AND a.name = ${identity.name} AND a.family IS NULL`
    : sql`AND a.name = ${identity.name} AND a.family = ${identity.family} AND a.version = ${identity.version}`
  const obsolete = sql`SELECT a.id FROM atom_checkpoints a WHERE a.pinned = 0 ${scope} AND ((a.family IS NULL AND EXISTS (SELECT 1 FROM atom_checkpoints newer WHERE newer.name = a.name AND newer.family IS NULL AND newer.position > a.position)) OR (a.family IS NOT NULL AND EXISTS (SELECT 1 FROM atom_checkpoints newer WHERE newer.family = a.family AND newer.version = a.version AND newer.name = a.name AND newer.position > a.position)))`
  yield* sql`DELETE FROM atom_checkpoint_chunks WHERE atom_id IN (${obsolete})`
  yield* sql`DELETE FROM atom_checkpoints WHERE id IN (${obsolete})`
})

// writeAtomCheckpoints commits regular and family state through the same chunk store (test/properties/checkpoint/schema.ts).
export const writeAtomCheckpoints = (sql: SqlClient.SqlClient, checkpoints: readonly AtomCheckpoint[], position: number, chunkBytes: number, pin = false) => Effect.gen(function* () {
  const names = new Set<string>()
  for (const entry of checkpoints) {
    if (!Number.isSafeInteger(entry.position) || entry.position < 0 || entry.position > position) return yield* Effect.fail(new RuntimeError("Invalid atom checkpoint position"))
    const identity = atomCheckpointKey(entry)
    if (names.has(identity)) return yield* Effect.fail(new RuntimeError("Duplicate atom checkpoint"))
    names.add(identity)
    const payload = encodeAtomCheckpoint(entry)
    const chunks = encodeCheckpointChunks(payload, chunkBytes)
    const digest = checkpointDigestSync(payload)
    yield* sql`INSERT INTO atom_checkpoints (name, family, version, position, byte_length, chunk_count, digest, pinned) VALUES (${entry.name}, ${entry.family ?? null}, ${entry.version ?? null}, ${entry.position}, ${payload.byteLength}, ${chunks.length}, ${digest}, ${pin ? 1 : 0}) ON CONFLICT DO UPDATE SET position = excluded.position, byte_length = excluded.byte_length, chunk_count = excluded.chunk_count, digest = excluded.digest, pinned = MAX(atom_checkpoints.pinned, excluded.pinned) WHERE atom_checkpoints.pinned = 0 OR atom_checkpoints.digest = excluded.digest`
    const rows = yield* find(sql, entry, entry.position)
    if (rows[0]?.position !== entry.position || rows[0]?.digest !== digest) return yield* Effect.fail(new RuntimeError("Pinned atom checkpoint cannot change"))
    const id = rows[0].id
    yield* sql`DELETE FROM atom_checkpoint_chunks WHERE atom_id = ${id}`
    for (const chunk of chunks) yield* sql`INSERT INTO atom_checkpoint_chunks (atom_id, ordinal, payload) VALUES (${id}, ${chunk.ordinal}, ${chunk.payload})`
    if (!pin) yield* collectAtomCheckpoints(sql, entry)
  }
})

// readAtomCheckpoint excludes future state and validates payload identity before recovery (test/properties/checkpoint/schema.ts).
export const readAtomCheckpoint = (sql: SqlClient.SqlClient, identity: AtomCheckpointIdentity, position: number): Effect.Effect<AtomCheckpoint | undefined, Error> => Effect.gen(function* () {
  if (!Number.isSafeInteger(position) || position < 0 || (identity.family === undefined) !== (identity.version === undefined)) return yield* Effect.fail(new RuntimeError("Invalid atom checkpoint read"))
  const rows = yield* find(sql, identity, position)
  const row = rows[0]
  if (!row || row.position > position) return undefined
  const chunks = yield* sql<CheckpointChunk>`SELECT ordinal, payload FROM atom_checkpoint_chunks WHERE atom_id = ${row.id} ORDER BY ordinal`
  const payload = decodeCheckpointChunks(chunks, row.byte_length, row.chunk_count)
  if (checkpointDigestSync(payload) !== row.digest) return yield* Effect.fail(new RuntimeError("Atom checkpoint digest mismatch"))
  const checkpoint = decodeAtomCheckpoint(payload)
  if (checkpoint.position !== row.position || checkpoint.name !== identity.name || checkpoint.family !== identity.family || checkpoint.version !== identity.version) return yield* Effect.fail(new RuntimeError("Atom checkpoint identity mismatch"))
  return checkpoint
})
