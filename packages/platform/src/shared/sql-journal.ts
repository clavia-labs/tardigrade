import { ThreadCreated, ThreadUpdated, CoreEvent, EffectRequested, EffectRef, InvocationIdentity, createInvocationLookup, hasCoreEventType } from "@clavia/tardigrade-core"
import { Effect, ManagedRuntime, Schema, Semaphore, Exit, Cause, Fiber, type Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { createScheduler, schedulerAlarm, JournalConflict, MessageMetadata, InboxMessageReceived, RuntimeError, type Recorded, type StoredCheckpoint, type Alarm, type ScheduledWake, type SchedulerPolicy, type SchedulerStorage, PendingEffectInput, effectKey, type EffectInputChanges } from "@clavia/tardigrade-core"
import { initializeSqlScheduler, sqlSchedulerTransaction } from "./sql-scheduler"
import { recordRetryWakes } from "./retry-wakes"
import { DEFAULT_FAMILY_INDEX_BATCH_SIZE, initializeSqlFamilyIndex, sqlFamilyIndex, type FamilyIndexOptions } from "./sql-family-index"
import type { JournalFamily, FamilyRecord } from "@clavia/tardigrade-core"
export { DEFAULT_FAMILY_INDEX_BATCH_SIZE, type FamilyIndexOptions } from "./sql-family-index"

import { checkpointDigestSync, journalCall } from "@clavia/tardigrade-core"
import { CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES, DEFAULT_CHECKPOINT_CHUNK_BYTES, validateCheckpointChunkBytes, encodeCheckpointChunks, decodeCheckpointChunks, type CheckpointChunk, type CheckpointChunkOptions } from "./checkpoint-chunks"
export { DEFAULT_CHECKPOINT_CHUNK_BYTES, type CheckpointChunkOptions } from "./checkpoint-chunks"

// decodeSqlJournalRecord reconstructs a logical record for journal readers and storage exporters (journalEventChunks).
export function decodeSqlJournalRecord<Event extends object>(text: string, chunks: readonly CheckpointChunk[] | (() => readonly CheckpointChunk[]) = []): Recorded<Event> {
  const stored = JSON.parse(text) as Recorded<Event> | { chunkCount: number; byteLength: number }
  if (!("chunkCount" in stored)) return stored
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeCheckpointChunks(typeof chunks === "function" ? chunks() : chunks, stored.byteLength, stored.chunkCount))) as Recorded<Event>
}

// readSqlJournalRecord restores a logical record before replay or message deduplication (journalEventChunks).
export const readSqlJournalRecord = <Event extends object>(sql: SqlClient.SqlClient, actor: string, row: { seq: number; event: string }): Effect.Effect<Recorded<Event>, Error> => Effect.gen(function* () {
  const stored = yield* Effect.try({ try: () => JSON.parse(row.event) as Recorded<Event> | { chunkCount: number; byteLength: number }, catch: RuntimeError.from })
  if (!("chunkCount" in stored)) return stored
  const chunks = yield* sql<CheckpointChunk>`SELECT ordinal, payload FROM experimental_event_chunks WHERE actor = ${actor} AND seq = ${row.seq} ORDER BY ordinal`
  return yield* Effect.try({ try: () => decodeSqlJournalRecord<Event>(row.event, chunks), catch: RuntimeError.from })
})

// indexInvocationRecord links invocation identities and references to physical journal rows (test/properties/checkpoint-storage.ts).
const indexInvocationRecord = (sql: SqlClient.SqlClient, actor: string, seq: number, record: Recorded<object>) => Effect.gen(function* () {
  if (!hasCoreEventType(record.event) || !("ref" in record.event)) return
  const event = yield* Schema.decodeEffect(Schema.toType(CoreEvent))(record.event).pipe(Effect.mapError(RuntimeError.from))
  if (!("ref" in event)) return
  const { ref } = event
  if (Schema.is(EffectRequested)(event)) {
    if (ref.seq !== seq) return yield* Effect.fail(new RuntimeError("Invocation acceptance differs from its journal position"))
    yield* sql`INSERT INTO experimental_invocation_requests (actor, atom, act, origin, seq) VALUES (${actor}, ${ref.atom}, ${ref.act}, ${event.origin ?? -1}, ${seq})`
  }
  yield* sql`INSERT INTO experimental_invocation_events (actor, atom, act, ref_seq, seq) VALUES (${actor}, ${ref.atom}, ${ref.act}, ${ref.seq}, ${seq})`
})

// DEFAULT_EVENT_INLINE_BYTES bounds inline UTF-8 record bytes before chunking (journalEventChunks).
export const DEFAULT_EVENT_INLINE_BYTES = 1_500_000
export const DEFAULT_INVOCATION_INDEX_BATCH_SIZE = 16
export interface JournalRecordOptions extends FamilyIndexOptions {
  readonly eventInlineBytes?: number | undefined
  readonly invocationIndexBatchSize?: number | undefined
}

export interface SqlJournalLimits { readonly maxRowBytes: number }

// sqlJournal owns a database with one checkpoint and commits checkpoint chunks with journal events (checkpointStorage).
export function sqlJournal<Event extends object>(options: CheckpointChunkOptions & JournalRecordOptions & {
  readonly actor: string
  readonly scheduler?: { readonly alarm: typeof Alarm.Service; readonly deliver: (wake: ScheduledWake) => Effect.Effect<void, Error>; readonly policy?: Partial<SchedulerPolicy> | undefined } | undefined
  readonly limits?: SqlJournalLimits
  readonly layer: Layer.Layer<SqlClient.SqlClient, Error>
  readonly flush?: Effect.Effect<void, Error>
  readonly acknowledge?: (write: () => undefined) => Effect.Effect<void, Error>
  readonly transaction?: <Value>(work: () => Value) => Value
  readonly commit?: (work: () => undefined, records: readonly Recorded<Event>[], position: number) => undefined
}) {
  if (!options.actor) throw new RuntimeError("Journal actor identity must be nonempty")
  const familyIndexBatchSize = options.familyIndexBatchSize ?? DEFAULT_FAMILY_INDEX_BATCH_SIZE
  if (!Number.isSafeInteger(familyIndexBatchSize) || familyIndexBatchSize < 1) throw new RuntimeError("familyIndexBatchSize must be a positive safe integer")
  const invocationIndexBatchSize = options.invocationIndexBatchSize ?? DEFAULT_INVOCATION_INDEX_BATCH_SIZE
  if (!Number.isSafeInteger(invocationIndexBatchSize) || invocationIndexBatchSize < 1) throw new RuntimeError("invocationIndexBatchSize must be a positive safe integer")
  const chunkBytes = options.checkpointChunkBytes ?? DEFAULT_CHECKPOINT_CHUNK_BYTES
  validateCheckpointChunkBytes(chunkBytes, options.limits ? options.limits.maxRowBytes - CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES : undefined)
  const actorBytes = new TextEncoder().encode(options.actor).byteLength
  const inlineCapacity = options.limits ? options.limits.maxRowBytes - actorBytes - CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES : Number.MAX_SAFE_INTEGER
  const eventChunkBytes = Math.min(chunkBytes, inlineCapacity)
  validateCheckpointChunkBytes(eventChunkBytes)
  const eventInlineBytes = options.eventInlineBytes ?? Math.min(DEFAULT_EVENT_INLINE_BYTES, inlineCapacity)
  if (!Number.isSafeInteger(eventInlineBytes) || eventInlineBytes < 1 || eventInlineBytes > inlineCapacity) throw new RuntimeError(`eventInlineBytes must be between 1 and ${inlineCapacity}`)
  const runtime = ManagedRuntime.make(options.layer)
  const transaction = <Value>(sql: SqlClient.SqlClient, work: Effect.Effect<Value, Error>): Effect.Effect<Value, Error> => options.transaction
    ? journalCall(() => options.transaction!(() => runSynchronous(work)))
    : sql.withTransaction(work)
  const familyIndex = sqlFamilyIndex<Event>({ actor: options.actor, batchSize: familyIndexBatchSize, transaction, readRecord: (sql, row) => readSqlJournalRecord<Event>(sql, options.actor, row) })
  const setup = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS experimental_events (actor TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (actor, seq)) WITHOUT ROWID`
    yield* sql`CREATE INDEX IF NOT EXISTS experimental_thread_versions ON experimental_events (actor, seq DESC) WHERE json_extract(event, '$.event.type') IN ('ThreadCreated', 'ThreadUpdated')`
    yield* sql`CREATE TABLE IF NOT EXISTS experimental_event_chunks (actor TEXT NOT NULL, seq INTEGER NOT NULL, ordinal INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY (actor, seq, ordinal), FOREIGN KEY (actor, seq) REFERENCES experimental_events(actor, seq)) WITHOUT ROWID`
    yield* sql`CREATE TABLE IF NOT EXISTS experimental_messages (actor TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (actor, id), FOREIGN KEY (actor, seq) REFERENCES experimental_events(actor, seq)) WITHOUT ROWID`
    yield* sql`CREATE TABLE IF NOT EXISTS experimental_invocation_requests (actor TEXT NOT NULL, atom TEXT NOT NULL, act TEXT NOT NULL, origin INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (actor, atom, act, origin), FOREIGN KEY (actor, seq) REFERENCES experimental_events(actor, seq)) WITHOUT ROWID`
    yield* sql`CREATE TABLE IF NOT EXISTS experimental_invocation_events (actor TEXT NOT NULL, atom TEXT NOT NULL, act TEXT NOT NULL, ref_seq INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (actor, atom, act, ref_seq, seq), FOREIGN KEY (actor, seq) REFERENCES experimental_events(actor, seq)) WITHOUT ROWID`
    yield* sql`CREATE TABLE IF NOT EXISTS experimental_invocation_index (actor TEXT PRIMARY KEY, position INTEGER NOT NULL) WITHOUT ROWID`
    yield* initializeSqlFamilyIndex(sql)
    yield* sql`CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), position INTEGER NOT NULL, byte_length INTEGER NOT NULL, chunk_count INTEGER NOT NULL, digest TEXT NOT NULL, tag TEXT)`
    const checkpointColumns = yield* sql<{ name: string }>`PRAGMA table_info(checkpoint)`
    if (!checkpointColumns.some(column => column.name === "tag")) yield* sql`ALTER TABLE checkpoint ADD COLUMN tag TEXT`
    yield* sql`CREATE TABLE IF NOT EXISTS checkpoint_chunks (ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 0), payload BLOB NOT NULL CHECK (typeof(payload) = 'blob' AND length(payload) > 0))`
    yield* sql`CREATE TABLE IF NOT EXISTS effect_inputs (actor TEXT NOT NULL, ref TEXT NOT NULL, byte_length INTEGER NOT NULL, chunk_count INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (actor, ref)) WITHOUT ROWID`
    yield* sql`CREATE TABLE IF NOT EXISTS effect_input_chunks (actor TEXT NOT NULL, ref TEXT NOT NULL, ordinal INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY (actor, ref, ordinal)) WITHOUT ROWID`
    // TODO: drop these statements once no database holds tables written by 0.49.0 to 0.50.0 checkpoint trees.
    for (const table of ["grove_nodes", "grove_chunks", "grove_owners", "checkpoint_trees"]) yield* sql.unsafe(`DROP TABLE IF EXISTS ${table}`)
    if (options.scheduler) yield* initializeSqlScheduler(sql)
    let complete = false
    while (!complete) complete = yield* transaction(sql, Effect.gen(function* () {
      const indexed = yield* sql<{ position: number }>`SELECT position FROM experimental_invocation_index WHERE actor = ${options.actor}`
      const position = indexed[0]?.position ?? 0
      const head = yield* sql<{ seq: number }>`SELECT seq FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq DESC LIMIT 1`
      const length = head.length === 0 ? 0 : head[0]!.seq + 1
      if (!Number.isSafeInteger(position) || position < 0 || position > length) return yield* Effect.fail(new RuntimeError("Invalid invocation index position"))
      const rows = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${options.actor} AND seq >= ${position} AND seq < ${length} ORDER BY seq LIMIT ${invocationIndexBatchSize}`
      if (rows.length !== Math.min(invocationIndexBatchSize, length - position)) return yield* Effect.fail(new RuntimeError("Invocation index journal range is unavailable"))
      for (const [index, row] of rows.entries()) {
        if (row.seq !== position + index) return yield* Effect.fail(new RuntimeError("Invalid invocation index journal sequence"))
        yield* indexInvocationRecord(sql, options.actor, row.seq, yield* readSqlJournalRecord(sql, options.actor, row))
      }
      yield* sql`INSERT INTO experimental_invocation_index (actor, position) VALUES (${options.actor}, ${position + rows.length}) ON CONFLICT(actor) DO UPDATE SET position = excluded.position`
      return position + rows.length === length
    }))
    return sql
  })
  const initialized = Effect.runSync(Effect.cached(runtime.contextEffect.pipe(Effect.flatMap(context => setup.pipe(Effect.provide(context))))))
  let closed = false
  const client = Effect.suspend(() => closed ? Effect.fail(new RuntimeError("Journal is closed")) : initialized)
  const scheduling = options.scheduler
  const wakeLock = Semaphore.makeUnsafe(1)
  const syncAlarm = (sql: SqlClient.SqlClient) => scheduling ? schedulerAlarm(sqlSchedulerTransaction(sql, scheduling.alarm)) : Effect.void
  const schedulerStorage: SchedulerStorage | undefined = scheduling ? { transaction: work => wakeLock.withPermit(Effect.gen(function* () {
    const sql = yield* client
    const result = yield* transaction(sql, work(sqlSchedulerTransaction(sql, scheduling.alarm)))
    yield* syncAlarm(sql)
    return result
  }).pipe(Effect.uninterruptible)) } : undefined
  const scheduler = scheduling && schedulerStorage ? createScheduler({ storage: schedulerStorage, deliver: scheduling.deliver, policy: scheduling.policy }) : undefined
  const append = (expectedLength: number, events: readonly Recorded<Event>[], providedCheckpoint?: StoredCheckpoint, inputs: EffectInputChanges = {}) => Effect.gen(function* () {
    const checkpoint = providedCheckpoint && { ...providedCheckpoint, payload: providedCheckpoint.payload.slice() }
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) return yield* Effect.fail(new RuntimeError("Invalid expected journal length"))
    if (checkpoint && (!Number.isSafeInteger(checkpoint.position) || checkpoint.position !== expectedLength + events.length || checkpoint.position < 0)) return yield* Effect.fail(new RuntimeError("Invalid checkpoint position"))
    const encoded = yield* Effect.try({ try: () => events.map(record => {
      if (record.message) {
        Schema.decodeSync(MessageMetadata, { onExcessProperty: "error" })(record.message)
        Schema.decodeUnknownSync(InboxMessageReceived, { onExcessProperty: "error" })(record.event)
      }
      const text = JSON.stringify(record)
      const payload = new TextEncoder().encode(text)
      const chunked = payload.byteLength > eventInlineBytes
      const chunks = chunked ? encodeCheckpointChunks(payload, eventChunkBytes) : []
      const event = "type" in record.event && typeof record.event.type === "string" ? { type: record.event.type } : undefined
      const stored = chunked ? JSON.stringify({ event, chunkCount: chunks.length, byteLength: payload.byteLength }) : text
      if (chunked && new TextEncoder().encode(stored).byteLength > inlineCapacity) throw new RuntimeError("Journal query metadata exceeds the SQL row capacity")
      return { text: stored, chunks }
    }), catch: RuntimeError.from })
    if (checkpoint && checkpoint.digest !== checkpointDigestSync(checkpoint.payload)) return yield* Effect.fail(new RuntimeError("Invalid checkpoint digest"))
    if (checkpoint?.tag !== undefined && !checkpoint.tag.trim()) return yield* Effect.fail(new RuntimeError("Checkpoint tag must be nonempty"))
    const chunks = checkpoint ? encodeCheckpointChunks(checkpoint.payload, chunkBytes) : []
    const pending = yield* Effect.forEach(inputs.put ?? [], input => Effect.gen(function* () {
      const value = yield* Schema.decodeEffect(PendingEffectInput)(input).pipe(Effect.mapError(RuntimeError.from))
      const payload = new TextEncoder().encode(JSON.stringify(value))
      const ref = effectKey(value.ref)
      const rowBytes = actorBytes + new TextEncoder().encode(ref).byteLength + CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES
      const inputChunkBytes = options.limits ? Math.min(chunkBytes, options.limits.maxRowBytes - rowBytes) : chunkBytes
      return { ref, payload, digest: checkpointDigestSync(payload), chunks: encodeCheckpointChunks(payload, inputChunkBytes) }
    }))
    const sql = yield* client
    if (familyIndex.size) {
      const head = yield* sql<{ seq: number }>`SELECT seq FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq DESC LIMIT 1`
      yield* familyIndex.catchUp(sql, head.length === 0 ? 0 : head[0]!.seq + 1)
    }
    const work = Effect.gen(function* () {
      const rows = yield* sql<{ seq: number }>`SELECT seq FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq DESC LIMIT 1`
      const count = rows.length === 0 ? 0 : rows[0]!.seq + 1
      if (count !== expectedLength) return yield* Effect.fail(new JournalConflict(`Journal conflict for ${options.actor}: expected ${expectedLength}, found ${String(count)}`))
      for (const [index, event] of encoded.entries()) {
        yield* sql`INSERT INTO experimental_events (actor, seq, event) VALUES (${options.actor}, ${expectedLength + index}, ${event.text})`
        for (const chunk of event.chunks) yield* sql`INSERT INTO experimental_event_chunks (actor, seq, ordinal, payload) VALUES (${options.actor}, ${expectedLength + index}, ${chunk.ordinal}, ${chunk.payload})`
        const message = events[index]!.message
        if (message) yield* sql`INSERT INTO experimental_messages (actor, id, seq) VALUES (${options.actor}, ${message.id}, ${expectedLength + index})`
        yield* indexInvocationRecord(sql, options.actor, expectedLength + index, events[index]!)
      }
      yield* sql`UPDATE experimental_invocation_index SET position = ${expectedLength + events.length} WHERE actor = ${options.actor}`
      yield* familyIndex.append(sql, expectedLength, events)
      for (const input of pending) {
        const existing = yield* sql<{ digest: string }>`SELECT digest FROM effect_inputs WHERE actor = ${options.actor} AND ref = ${input.ref}`
        if (existing.length && existing[0]!.digest !== input.digest) return yield* Effect.fail(new RuntimeError("Accepted effect input cannot change"))
        if (existing.length) continue
        yield* sql`INSERT INTO effect_inputs (actor, ref, byte_length, chunk_count, digest) VALUES (${options.actor}, ${input.ref}, ${input.payload.byteLength}, ${input.chunks.length}, ${input.digest})`
        for (const chunk of input.chunks) yield* sql`INSERT INTO effect_input_chunks (actor, ref, ordinal, payload) VALUES (${options.actor}, ${input.ref}, ${chunk.ordinal}, ${chunk.payload})`
      }
      for (const ref of inputs.remove ?? []) {
        const key = effectKey(ref)
        yield* sql`DELETE FROM effect_input_chunks WHERE actor = ${options.actor} AND ref = ${key}`
        yield* sql`DELETE FROM effect_inputs WHERE actor = ${options.actor} AND ref = ${key}`
      }
      if (scheduling) yield* recordRetryWakes(sqlSchedulerTransaction(sql, scheduling.alarm), events)
      if (checkpoint) {
        yield* sql`DELETE FROM checkpoint_chunks`
        yield* sql`INSERT INTO checkpoint (id, position, byte_length, chunk_count, digest, tag) VALUES (1, ${checkpoint.position}, ${checkpoint.payload.byteLength}, ${chunks.length}, ${checkpoint.digest}, ${checkpoint.tag ?? null}) ON CONFLICT(id) DO UPDATE SET position = excluded.position, byte_length = excluded.byte_length, chunk_count = excluded.chunk_count, digest = excluded.digest, tag = excluded.tag`
        for (const chunk of chunks) yield* sql`INSERT INTO checkpoint_chunks (ordinal, payload) VALUES (${chunk.ordinal}, ${chunk.payload})`
      }
    })
    yield* options.commit ? journalCall(() => options.commit!(() => { runSynchronous(work); return undefined }, events, expectedLength + events.length)) : transaction(sql, work)
  })
  const readPosition = Effect.gen(function* () {
    const sql = yield* client
    const rows = yield* sql<{ seq: number }>`SELECT seq FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq DESC LIMIT 1`
    const position = rows.length === 0 ? 0 : rows[0]!.seq + 1
    if (!Number.isSafeInteger(position) || position < 0) return yield* Effect.fail(new RuntimeError("Invalid journal position"))
    return position
  })
  const readRange = (from: number, to: number) => Effect.gen(function* () {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return yield* Effect.fail(new RuntimeError("Invalid journal range"))
    const sql = yield* client
    const position = yield* readPosition
    if (to > position) return yield* Effect.fail(new RuntimeError("Journal range is unavailable"))
    const rows = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${options.actor} AND seq >= ${from} AND seq < ${to} ORDER BY seq`
    if (rows.length !== to - from) return yield* Effect.fail(new RuntimeError("Journal range is unavailable"))
    return yield* Effect.forEach(rows, (row, index) => {
      if (row.seq !== from + index || typeof row.event !== "string") return Effect.fail(new RuntimeError("Invalid journal sequence"))
      return readSqlJournalRecord<Event>(sql, options.actor, row)
    })
  })
  const access = {
    readPosition, readRange,
    readOperation: (ref: EffectRef, position: number) => Effect.gen(function* () {
      const reference = yield* Schema.decodeEffect(EffectRef, { onExcessProperty: "error" })(ref).pipe(Effect.mapError(RuntimeError.from))
      if (!Number.isSafeInteger(position) || position < 0) return yield* Effect.fail(new RuntimeError("Invalid journal position"))
      const sql = yield* client
      const length = yield* readPosition
      if (position > length) return yield* Effect.fail(new RuntimeError("Operation position exceeds journal length"))
      const rows = yield* sql<{ seq: number; event: string | null }>`SELECT i.seq, e.event FROM experimental_invocation_events i LEFT JOIN experimental_events e ON e.actor = i.actor AND e.seq = i.seq WHERE i.actor = ${options.actor} AND i.atom = ${reference.atom} AND i.act = ${reference.act} AND i.ref_seq = ${reference.seq} AND i.seq < ${position} ORDER BY i.seq`
      if (rows.length === 0) {
        const accepted = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${options.actor} AND seq = ${reference.seq} AND seq < ${position}`
        if (accepted[0]) {
          const record = yield* readSqlJournalRecord<Event>(sql, options.actor, accepted[0])
          if (Schema.is(EffectRequested)(record.event) && effectKey(record.event.ref) === effectKey(reference)) return yield* Effect.fail(new RuntimeError("Operation index is missing journal records"))
        }
        return []
      }
      return yield* Effect.forEach(rows, (row, index) => Effect.gen(function* () {
        if (row.event === null) return yield* Effect.fail(new RuntimeError("Operation index is missing journal records"))
        const record = yield* readSqlJournalRecord<Event>(sql, options.actor, { seq: row.seq, event: row.event })
        const event = yield* Schema.decodeUnknownEffect(Schema.toType(CoreEvent))(record.event).pipe(Effect.mapError(RuntimeError.from))
        if (!("ref" in event) || effectKey(event.ref) !== effectKey(reference) || (index === 0 && (row.seq !== reference.seq || event.type !== "EffectRequested")) || (index > 0 && event.type === "EffectRequested")) return yield* Effect.fail(new RuntimeError("Operation index differs from its acceptance"))
        return record
      }))
    }),
    lookupInvocation: (identity: InvocationIdentity) => Effect.gen(function* () {
      const sql = yield* client
      const rows = yield* sql<{ seq: number | null; event: string | null }>`SELECT e.seq, e.event FROM experimental_invocation_requests r LEFT JOIN experimental_invocation_events i ON i.actor = r.actor AND i.atom = r.atom AND i.act = r.act AND i.ref_seq = r.seq LEFT JOIN experimental_events e ON e.actor = i.actor AND e.seq = i.seq WHERE r.actor = ${options.actor} AND r.atom = ${identity.atom} AND r.act = ${identity.act} AND r.origin = ${identity.origin ?? -1} ORDER BY e.seq`
      return yield* Effect.forEach(rows, row => row.seq === null || row.event === null ? Effect.fail(new RuntimeError("Invocation index is missing journal records")) : readSqlJournalRecord(sql, options.actor, { seq: row.seq, event: row.event }))
    }),
    readMessage: (id: string) => Effect.gen(function* () {
      const sql = yield* client
      const rows = yield* sql<{ seq: number; event: string }>`SELECT e.seq, e.event FROM experimental_messages m JOIN experimental_events e ON e.actor = m.actor AND e.seq = m.seq WHERE m.actor = ${options.actor} AND m.id = ${id}`
      const row = rows[0]
      if (!row) return undefined
      if (!Number.isSafeInteger(row.seq) || row.seq < 0) return yield* Effect.fail(new RuntimeError("Invalid message journal sequence"))
      const record = yield* readSqlJournalRecord<Event>(sql, options.actor, row)
      if (record.message?.id !== id) return yield* Effect.fail(new RuntimeError("Message index differs from its journal record"))
      return { position: row.seq + 1, record }
    }),
    readFirst: Effect.gen(function* () {
      const sql = yield* client
      const rows = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq LIMIT 1`
      const row = rows[0]
      if (!row) return undefined
      if (row.seq !== 0 || typeof row.event !== "string") return yield* Effect.fail(new RuntimeError("Invalid first journal sequence"))
      return yield* readSqlJournalRecord<Event>(sql, options.actor, row)
    }),
    readVersion: Effect.gen(function* () {
      const sql = yield* client
      return yield* transaction(sql, Effect.gen(function* () {
        const head = yield* sql<{ seq: number }>`SELECT seq FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq DESC LIMIT 1`
        const position = head.length === 0 ? 0 : head[0]!.seq + 1
        if (!Number.isSafeInteger(position) || position < 0) return yield* Effect.fail(new RuntimeError("Invalid journal position"))
        const rows = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${options.actor} AND json_extract(event, '$.event.type') IN ('ThreadCreated', 'ThreadUpdated') ORDER BY seq DESC LIMIT 1`
        const pending = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM effect_inputs WHERE actor = ${options.actor}`
        const pendingEffects = pending[0]!.count
        const row = rows[0]
        if (!row) return { position, pendingEffects }
        const record = yield* readSqlJournalRecord<Event>(sql, options.actor, row)
        const lifecycle = yield* Schema.decodeUnknownEffect(Schema.Union([ThreadCreated, ThreadUpdated]))(record.event).pipe(Effect.mapError(RuntimeError.from))
        return { position, pendingEffects, ...(lifecycle.version === undefined ? {} : { version: lifecycle.version }) }
      }))
    }),
    read: readPosition.pipe(Effect.flatMap(position => readRange(0, position))),
    readBefore: (position: number) => readRange(0, position),
    readAfter: (position: number) => readPosition.pipe(Effect.flatMap(head => readRange(position, head))),
    readInputs: Effect.gen(function* () {
      const sql = yield* client
      return yield* transaction(sql, Effect.gen(function* () {
        const rows = yield* sql<{ ref: string; byte_length: number; chunk_count: number; digest: string }>`SELECT ref, byte_length, chunk_count, digest FROM effect_inputs WHERE actor = ${options.actor}`
        return yield* Effect.forEach(rows, row => Effect.gen(function* () {
          const chunks = yield* sql<CheckpointChunk>`SELECT ordinal, payload FROM effect_input_chunks WHERE actor = ${options.actor} AND ref = ${row.ref} ORDER BY ordinal`
          const payload = yield* Effect.try({ try: () => decodeCheckpointChunks(chunks, row.byte_length, row.chunk_count), catch: RuntimeError.from })
          if ((checkpointDigestSync(payload)) !== row.digest) return yield* Effect.fail(new RuntimeError("Pending effect input digest mismatch"))
          const raw = yield* Effect.try({ try: (): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)), catch: RuntimeError.from })
          const input = yield* Schema.decodeUnknownEffect(PendingEffectInput)(raw).pipe(Effect.mapError(RuntimeError.from))
          if (effectKey(input.ref) !== row.ref || input.ref.act !== input.request.act) return yield* Effect.fail(new RuntimeError("Pending effect input identity mismatch"))
          return input
        }))
      }))
    }),
    append: (position: number, events: readonly Recorded<Event>[], inputs?: EffectInputChanges) => append(position, events, undefined, inputs),
    readCheckpoint: (tag?: string) => Effect.gen(function* () {
      const sql = yield* client
      return yield* transaction(sql, Effect.gen(function* () {
        const rows = yield* sql<{ position: number; byte_length: number; chunk_count: number; digest: string; tag: string | null }>`SELECT position, byte_length, chunk_count, digest, tag FROM checkpoint WHERE id = 1`
        const row = rows[0]
        if (!row) return undefined
        if (tag !== undefined && row.tag !== tag) return undefined
        if (!Number.isSafeInteger(row.position) || row.position < 0 || typeof row.digest !== "string") return yield* Effect.fail(new RuntimeError("Invalid journal checkpoint"))
        const chunks = yield* sql<CheckpointChunk>`SELECT ordinal, payload FROM checkpoint_chunks ORDER BY ordinal`
        const payload = yield* Effect.try({ try: () => decodeCheckpointChunks(chunks, row.byte_length, row.chunk_count), catch: RuntimeError.from })
        if ((checkpointDigestSync(payload)) !== row.digest) return yield* Effect.fail(new RuntimeError("Journal checkpoint digest mismatch"))
        return { position: row.position, payload, digest: row.digest, ...(row.tag === null ? {} : { tag: row.tag }) } satisfies StoredCheckpoint
      }))
    }),
    appendWithCheckpoint: append,
  }
  return {
    scheduler,
    lookupInvocation: createInvocationLookup(identity => runSynchronous(access.lookupInvocation(identity))),
    readPosition: () => runSynchronous(access.readPosition),
    readRange: (from: number, to: number) => runSynchronous(access.readRange(from, to)),
    readOperation: (ref: EffectRef, position: number) => runSynchronous(access.readOperation(ref, position)),
    readFamily: function* (family: JournalFamily, key: string, from: number, to: number): Iterable<FamilyRecord<Recorded<Event>>> {
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new RuntimeError("Invalid journal family range")
      const sql = runSynchronous(client)
      const position = runSynchronous(readPosition)
      if (to > position) throw new RuntimeError("Journal family range is unavailable")
      runSynchronous(familyIndex.prepare(sql, family, position))
      let cursor = from
      while (cursor < to) {
        const page = runSynchronous(familyIndex.readPage(sql, family, key, cursor, to))
        if (!page.length) return
        yield* page
        cursor = page[page.length - 1]!.position + 1
      }
    },
    readFamilyKeys: (family: JournalFamily, after: string | undefined, limit: number, position: number): readonly string[] => {
      if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(position) || position < 0) throw new RuntimeError("Invalid journal family key range")
      const sql = runSynchronous(client)
      const length = runSynchronous(readPosition)
      if (position > length) throw new RuntimeError("Journal family key range is unavailable")
      runSynchronous(familyIndex.prepare(sql, family, length))
      return runSynchronous(familyIndex.readKeys(sql, family, after, limit, position))
    },
    read: () => runSynchronous(access.read),
    readAfter: (position: number) => runSynchronous(access.readAfter(position)),
    readBefore: (position: number) => runSynchronous(access.readBefore(position)),
    readInputs: () => runSynchronous(access.readInputs),
    readCheckpoint: (tag?: string) => runSynchronous(access.readCheckpoint(tag)),
    readFirst: () => runSynchronous(access.readFirst),
    readVersion: () => runSynchronous(access.readVersion),
    readMessage: (id: string) => runSynchronous(access.readMessage(id)),
    append: (position: number, events: readonly Recorded<Event>[], inputs?: EffectInputChanges) => { runSynchronous(access.append(position, events, inputs)); return undefined },
    appendWithCheckpoint: (position: number, events: readonly Recorded<Event>[], checkpoint: StoredCheckpoint, inputs?: EffectInputChanges) => { runSynchronous(access.appendWithCheckpoint(position, events, checkpoint, inputs)); return undefined },
    acknowledge: (write?: () => undefined) => wakeLock.withPermit(Effect.gen(function* () {
      const sql = yield* client
      if (options.acknowledge) yield* options.acknowledge(write ?? (() => undefined))
      else if (write) yield* journalCall(write)
      yield* syncAlarm(sql)
      if (options.flush) yield* options.flush
    }).pipe(Effect.uninterruptible)),
    close: Effect.sync(() => { closed = true }).pipe(Effect.andThen(runtime.disposeEffect)),
  }
}

// runSynchronous rejects storage work that suspends and preserves transaction failures for rollback (test/properties/checkpoint-storage.ts).
export const runSynchronous = <Value>(work: Effect.Effect<Value, Error>): Value => {
  const context = Fiber.getCurrent()?.context
  const result = Effect.runSyncExit(context ? work.pipe(Effect.provideContext(context)) : work)
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
  return result.value
}
