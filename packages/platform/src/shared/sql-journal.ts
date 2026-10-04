import { Effect, ManagedRuntime, Schema, type Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { JournalConflict, MessageMetadata, InboxMessageReceived, RuntimeError, type Recorded, type StoredCheckpoint } from "@clavia/tardigrade-core"
import type { ThreadJournal } from "@clavia/tardigrade-core"

import { checkpointDigest } from "@clavia/tardigrade-core"
import { CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES, DEFAULT_CHECKPOINT_CHUNK_BYTES, validateCheckpointChunkBytes, encodeCheckpointChunks, decodeCheckpointChunks, type CheckpointChunk, type CheckpointChunkOptions } from "./checkpoint-chunks"
export { DEFAULT_CHECKPOINT_CHUNK_BYTES, type CheckpointChunkOptions } from "./checkpoint-chunks"

export interface SqlJournalLimits { readonly maxRowBytes: number }

// sqlJournal owns a database with one checkpoint and commits checkpoint chunks with journal events (checkpointStorage).
export function sqlJournal<Event extends object>(options: CheckpointChunkOptions & {
  readonly actor: string
  readonly limits?: SqlJournalLimits
  readonly layer: Layer.Layer<SqlClient.SqlClient, Error>
  readonly flush?: Effect.Effect<void, Error>
  readonly commit?: (work: Effect.Effect<void, Error>, records: readonly Recorded<Event>[], position: number) => Effect.Effect<void, Error>
}): ThreadJournal<Event> & { readonly close: Effect.Effect<void, Error> } {
  if (!options.actor) throw new RuntimeError("Journal actor identity must be nonempty")
  const chunkBytes = options.checkpointChunkBytes ?? DEFAULT_CHECKPOINT_CHUNK_BYTES
  validateCheckpointChunkBytes(chunkBytes, options.limits ? options.limits.maxRowBytes - CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES : undefined)
  const runtime = ManagedRuntime.make(options.layer)
  const setup = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS experimental_events (actor TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (actor, seq)) WITHOUT ROWID`
    yield* sql`CREATE TABLE IF NOT EXISTS experimental_messages (actor TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (actor, id), FOREIGN KEY (actor, seq) REFERENCES experimental_events(actor, seq)) WITHOUT ROWID`
    yield* sql`CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), position INTEGER NOT NULL, byte_length INTEGER NOT NULL, chunk_count INTEGER NOT NULL, digest TEXT NOT NULL)`
    yield* sql`CREATE TABLE IF NOT EXISTS checkpoint_chunks (ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 0), payload BLOB NOT NULL CHECK (typeof(payload) = 'blob' AND length(payload) > 0))`
    return sql
  })
  const initialized = Effect.runSync(Effect.cached(runtime.contextEffect.pipe(Effect.flatMap(context => setup.pipe(Effect.provide(context))))))
  let closed = false
  const client = Effect.suspend(() => closed ? Effect.fail(new RuntimeError("Journal is closed")) : initialized)
  const append = (expectedLength: number, events: readonly Recorded<Event>[], providedCheckpoint?: StoredCheckpoint) => Effect.gen(function* () {
    const checkpoint = providedCheckpoint && { ...providedCheckpoint, payload: providedCheckpoint.payload.slice() }
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) return yield* Effect.fail(new RuntimeError("Invalid expected journal length"))
    if (checkpoint && (!Number.isSafeInteger(checkpoint.position) || checkpoint.position !== expectedLength + events.length || checkpoint.position < 0)) return yield* Effect.fail(new RuntimeError("Invalid checkpoint position"))
    const encoded = yield* Effect.try({ try: () => events.map(record => {
      if (record.message) {
        Schema.decodeSync(MessageMetadata, { onExcessProperty: "error" })(record.message)
        Schema.decodeUnknownSync(InboxMessageReceived, { onExcessProperty: "error" })(record.event)
      }
      return JSON.stringify(record)
    }), catch: RuntimeError.from })
    if (checkpoint && checkpoint.digest !== (yield* checkpointDigest(checkpoint.payload))) return yield* Effect.fail(new RuntimeError("Invalid checkpoint digest"))
    const chunks = checkpoint ? encodeCheckpointChunks(checkpoint.payload, chunkBytes) : []
    const sql = yield* client
    const work = Effect.gen(function* () {
      const rows = yield* sql<{ seq: number }>`SELECT seq FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq DESC LIMIT 1`
      const count = rows.length === 0 ? 0 : rows[0]!.seq + 1
      if (count !== expectedLength) return yield* Effect.fail(new JournalConflict(`Journal conflict for ${options.actor}: expected ${expectedLength}, found ${String(count)}`))
      for (const [index, event] of encoded.entries()) {
        yield* sql`INSERT INTO experimental_events (actor, seq, event) VALUES (${options.actor}, ${expectedLength + index}, ${event})`
        const message = events[index]!.message
        if (message) yield* sql`INSERT INTO experimental_messages (actor, id, seq) VALUES (${options.actor}, ${message.id}, ${expectedLength + index})`
      }
      if (checkpoint) {
        yield* sql`DELETE FROM checkpoint_chunks`
        yield* sql`INSERT INTO checkpoint (id, position, byte_length, chunk_count, digest) VALUES (1, ${checkpoint.position}, ${checkpoint.payload.byteLength}, ${chunks.length}, ${checkpoint.digest}) ON CONFLICT(id) DO UPDATE SET position = excluded.position, byte_length = excluded.byte_length, chunk_count = excluded.chunk_count, digest = excluded.digest`
        for (const chunk of chunks) yield* sql`INSERT INTO checkpoint_chunks (ordinal, payload) VALUES (${chunk.ordinal}, ${chunk.payload})`
      }
    }).pipe(Effect.mapError(RuntimeError.from))
    yield* options.commit ? options.commit(work, events, expectedLength + events.length) : sql.withTransaction(work)
    if (options.flush) yield* options.flush
  })
  return {
    acknowledge: client.pipe(Effect.andThen(options.flush ?? Effect.void)),
    readMessage: id => Effect.gen(function* () {
      const sql = yield* client
      const rows = yield* sql<{ seq: number; event: string }>`SELECT e.seq, e.event FROM experimental_messages m JOIN experimental_events e ON e.actor = m.actor AND e.seq = m.seq WHERE m.actor = ${options.actor} AND m.id = ${id}`
      return yield* Effect.try({ try: () => {
        const row = rows[0]
        if (!row) return undefined
        if (!Number.isSafeInteger(row.seq) || row.seq < 0) throw new RuntimeError("Invalid message journal sequence")
        const record = JSON.parse(row.event) as Recorded<Event>
        if (record.message?.id !== id) throw new RuntimeError("Message index differs from its journal record")
        return { position: row.seq + 1, record }
      }, catch: RuntimeError.from })
    }),
    readFirst: Effect.gen(function* () {
      const sql = yield* client
      const rows = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq LIMIT 1`
      return yield* Effect.try({ try: () => {
        const row = rows[0]
        if (!row) return undefined
        if (row.seq !== 0 || typeof row.event !== "string") throw new RuntimeError("Invalid first journal sequence")
        return JSON.parse(row.event) as Recorded<Event>
      }, catch: RuntimeError.from })
    }),
    read: Effect.gen(function* () {
      const sql = yield* client
      const rows = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq`
      return yield* Effect.try({ try: () => rows.map((row, index) => {
        if (row.seq !== index || typeof row.event !== "string") throw new RuntimeError("Invalid journal sequence")
        return JSON.parse(row.event) as Recorded<Event>
      }), catch: RuntimeError.from })
    }),
    readAfter: (position) => Effect.gen(function* () {
      if (!Number.isSafeInteger(position) || position < 0) return yield* Effect.fail(new RuntimeError("Invalid journal position"))
      const sql = yield* client
      const last = yield* sql<{ seq: number }>`SELECT seq FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq DESC LIMIT 1`
      const length = last.length === 0 ? 0 : last[0]!.seq + 1
      if (!Number.isSafeInteger(length) || length < 0 || position > length) return yield* Effect.fail(new RuntimeError("Checkpoint position exceeds journal length"))
      const rows = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${options.actor} AND seq >= ${position} ORDER BY seq`
      return yield* Effect.try({ try: () => rows.map((row, index) => {
        if (row.seq !== position + index || typeof row.event !== "string") throw new RuntimeError("Invalid journal sequence")
        return JSON.parse(row.event) as Recorded<Event>
      }), catch: RuntimeError.from })
    }),
    append,
    readCheckpoint: Effect.gen(function* () {
      const sql = yield* client
      return yield* sql.withTransaction(Effect.gen(function* () {
        const rows = yield* sql<{ position: number; byte_length: number; chunk_count: number; digest: string }>`SELECT position, byte_length, chunk_count, digest FROM checkpoint WHERE id = 1`
        const row = rows[0]
        if (!row) return undefined
        if (!Number.isSafeInteger(row.position) || row.position < 0 || typeof row.digest !== "string") return yield* Effect.fail(new RuntimeError("Invalid journal checkpoint"))
        const chunks = yield* sql<CheckpointChunk>`SELECT ordinal, payload FROM checkpoint_chunks ORDER BY ordinal`
        const payload = yield* Effect.try({ try: () => decodeCheckpointChunks(chunks, row.byte_length, row.chunk_count), catch: RuntimeError.from })
        if ((yield* checkpointDigest(payload)) !== row.digest) return yield* Effect.fail(new RuntimeError("Journal checkpoint digest mismatch"))
        return { position: row.position, payload, digest: row.digest } satisfies StoredCheckpoint
      }))
    }),
    appendWithCheckpoint: append,
    close: Effect.sync(() => { closed = true }).pipe(Effect.andThen(runtime.disposeEffect)),
  }
}
