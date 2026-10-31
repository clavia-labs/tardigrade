import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { checkpointDigestSync, encodeCheckpoint, RuntimeError, type StoredCheckpoint, decodeCheckpointManifest, encodeActorCheckpointV4, LEGACY_ACTOR_CHECKPOINT_VERSION } from "@clavia/tardigrade-core"
import { encodeCheckpointChunks, decodeCheckpointChunks, type CheckpointChunk } from "./chunks"
import { readAtomCheckpoint, writeAtomCheckpoints, collectAtomCheckpoints } from "./atoms"
import { splitActorCheckpoint } from "./manifest"

// writeActorCheckpoint commits a recovery manifest and its referenced atom states atomically (test/properties/checkpoint/schema.ts).
export const writeActorCheckpoint = (sql: SqlClient.SqlClient, checkpoint: StoredCheckpoint, chunkBytes: number) => Effect.gen(function* () {
  const split = splitActorCheckpoint(checkpoint)
  const chunks = encodeCheckpointChunks(split.payload, chunkBytes)
  yield* sql`UPDATE atom_checkpoints SET pinned = 0 WHERE pinned = 1`
  yield* writeAtomCheckpoints(sql, split.atoms, checkpoint.position, chunkBytes, true)
  yield* sql`DELETE FROM checkpoint_chunks`
  yield* sql`INSERT INTO checkpoint (id, position, byte_length, chunk_count, digest, tag, encoding, storage_byte_length, storage_digest) VALUES (1, ${checkpoint.position}, ${checkpoint.payload.byteLength}, ${chunks.length}, ${checkpoint.digest}, ${checkpoint.tag ?? null}, ${split.encoding}, ${split.payload.byteLength}, ${checkpointDigestSync(split.payload)}) ON CONFLICT(id) DO UPDATE SET position = excluded.position, byte_length = excluded.byte_length, chunk_count = excluded.chunk_count, digest = excluded.digest, tag = excluded.tag, encoding = excluded.encoding, storage_byte_length = excluded.storage_byte_length, storage_digest = excluded.storage_digest`
  for (const chunk of chunks) yield* sql`INSERT INTO checkpoint_chunks (ordinal, payload) VALUES (${chunk.ordinal}, ${chunk.payload})`
  yield* collectAtomCheckpoints(sql)
})

// readActorCheckpoint reconstructs the actor's exact payload at its saved recovery boundary (test/properties/checkpoint/schema.ts).
export const readActorCheckpoint = (sql: SqlClient.SqlClient, tag?: string): Effect.Effect<StoredCheckpoint | undefined, Error> => Effect.gen(function* () {
  const rows = yield* sql<{ position: number; byte_length: number; chunk_count: number; digest: string; tag: string | null; encoding: number; storage_byte_length: number | null; storage_digest: string | null }>`SELECT position, byte_length, chunk_count, digest, tag, encoding, storage_byte_length, storage_digest FROM checkpoint WHERE id = 1`
  const row = rows[0]
  if (!row || (tag !== undefined && row.tag !== tag)) return undefined
  if (!Number.isSafeInteger(row.position) || row.position < 0 || typeof row.digest !== "string") return yield* Effect.fail(new RuntimeError("Invalid journal checkpoint"))
  const chunks = yield* sql<CheckpointChunk>`SELECT ordinal, payload FROM checkpoint_chunks ORDER BY ordinal`
  let payload = decodeCheckpointChunks(chunks, row.storage_byte_length ?? row.byte_length, row.chunk_count)
  if (checkpointDigestSync(payload) !== (row.storage_digest ?? row.digest)) return yield* Effect.fail(new RuntimeError("Journal checkpoint digest mismatch"))
  if (row.encoding === 1) {
    const manifest = decodeCheckpointManifest(payload)
    if (manifest.position !== row.position) return yield* Effect.fail(new RuntimeError("Invalid actor checkpoint manifest"))
    const durable = yield* Effect.forEach(manifest.atoms, reference => Effect.gen(function* () {
      const atom = yield* readAtomCheckpoint(sql, reference, reference.position)
      if (!atom || atom.position !== reference.position) return yield* Effect.fail(new RuntimeError("Actor checkpoint atom is unavailable"))
      return atom
    }))
    payload = manifest.checkpointVersion === LEGACY_ACTOR_CHECKPOINT_VERSION ? encodeActorCheckpointV4({ position: row.position, durable }) : encodeCheckpoint({ position: row.position, durable })
  } else if (row.encoding !== 0) return yield* Effect.fail(new RuntimeError("Unsupported actor checkpoint encoding"))
  if (payload.byteLength !== row.byte_length || checkpointDigestSync(payload) !== row.digest) return yield* Effect.fail(new RuntimeError("Journal checkpoint digest mismatch"))
  return { position: row.position, payload, digest: row.digest, ...(row.tag === null ? {} : { tag: row.tag }) }
})
