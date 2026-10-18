import { Schema, Effect } from "effect"
import { isDeepStrictEqual } from "node:util"
import { decodeReference } from "@tardie/grove"
import { makeSync, type SyncSqlite, type SyncOptions, type Transaction } from "@tardie/grove/sqlite"
import { storedSession, JournalConflict, RuntimeError, PendingEffectInput, effectKey, checkpointDigest, decodeCheckpoint, MessageMetadata, InboxMessageReceived, ThreadCreated, type MessageJournal, type Recorded, type EffectInputChanges, type StoredCheckpoint } from "@clavia/tardigrade-core"

import { DEFAULT_CHECKPOINT_CHUNK_BYTES, CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES, validateCheckpointChunkBytes, encodeCheckpointChunks, type CheckpointChunkOptions } from "./checkpoint-chunks"
import { DEFAULT_EVENT_INLINE_BYTES, decodeSqlJournalRecord, type JournalRecordOptions, type SqlJournalLimits } from "./journal-records"
import { storedPayloadBytes, storedPayloadDigest, type StoredPayloadRow, type StoredPayloadChunk } from "./stored-journal-payloads"
import { createScheduler, createWatchdog, ThreadUpdated, type Alarm, type SchedulerStorage, type SchedulerPolicy, type ScheduledWake, type WatchdogStorage, type WatchdogTarget } from "@clavia/tardigrade-core"
import { initializeSyncRecovery, syncRecoveryTransaction, synchronousRecoveryStorage, recoveryLock } from "./synchronous-recovery"
import { initializeJournal } from "./journal-schema"
import { journalMigration } from "./migrate-journal"
import { recordRetryWakes } from "./retry-wakes"

export interface SynchronousRecoveryOptions {
  readonly scheduler?: { readonly alarm: typeof Alarm.Service; readonly deliver: (wake: ScheduledWake) => Effect.Effect<void, Error>; readonly policy?: Partial<SchedulerPolicy> | undefined } | undefined
  readonly watchdog?: (Omit<Parameters<typeof createWatchdog>[0], "storage"> | { readonly instance: ReturnType<typeof createWatchdog> }) & { readonly target: WatchdogTarget } | undefined
  readonly collectEvery?: number | undefined
  readonly flush?: Effect.Effect<void, Error> | undefined
}

// synchronousJournal shares Grove retention and journal writes in a native transaction (test/bun/journal.test.ts).
export function synchronousJournal<Event extends object>(options: Omit<SyncOptions, "scope"> & Pick<CheckpointChunkOptions, "checkpointChunkBytes"> & JournalRecordOptions & SynchronousRecoveryOptions & { readonly limits?: SqlJournalLimits; readonly scope?: string; readonly actor: string; readonly driver: SyncSqlite }) {
  if (!options.actor.trim()) throw new Error("Journal actor must be nonempty")
  if (options.watchdog && !options.scheduler) throw new Error("Watchdog requires a scheduler alarm and delivery handler")
  if (options.collectEvery !== undefined && (!Number.isSafeInteger(options.collectEvery) || options.collectEvery < 1)) throw new Error("collectEvery must be a positive safe integer")
  const { driver, actor } = options
  const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true })
  const actorBytes = encoder.encode(actor).byteLength
  const maxRowBytes = options.limits?.maxRowBytes
  if (maxRowBytes !== undefined && (!Number.isSafeInteger(maxRowBytes) || maxRowBytes < 1)) throw new Error("maxRowBytes must be a positive safe integer")
  const chunkCapacity = maxRowBytes === undefined ? Number.MAX_SAFE_INTEGER : maxRowBytes - CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES
  const checkpointChunkBytes = options.checkpointChunkBytes ?? Math.min(DEFAULT_CHECKPOINT_CHUNK_BYTES, chunkCapacity)
  validateCheckpointChunkBytes(checkpointChunkBytes, chunkCapacity)
  const inlineCapacity = chunkCapacity - actorBytes
  const eventChunkBytes = Math.min(checkpointChunkBytes, inlineCapacity)
  const eventInlineBytes = options.eventInlineBytes ?? Math.min(DEFAULT_EVENT_INLINE_BYTES, inlineCapacity)
  if (!Number.isSafeInteger(eventInlineBytes) || eventInlineBytes < 1 || eventInlineBytes > inlineCapacity) throw new Error(`eventInlineBytes must be between 1 and ${inlineCapacity}`)
  const inputChunkBytes = (key: string) => {
    const capacity = chunkCapacity - encoder.encode(key).byteLength
    const size = Math.min(checkpointChunkBytes, capacity)
    validateCheckpointChunkBytes(size)
    if (capacity < 64) throw new Error("Effect input identity exceeds the journal row capacity")
    return size
  }
  const scope = options.scope ?? JSON.stringify(["tardigrade", actor])
  const query = <Row>(sql: string, parameters: readonly (string | number | null | Uint8Array)[] = []) => driver.execute(sql, parameters) as readonly Row[]
  const bytes = (row: StoredPayloadRow, table: string, keyColumn: string, key: string | number) => storedPayloadBytes(row, () => query<StoredPayloadChunk>(`SELECT ordinal,payload FROM ${table}${keyColumn ? ` WHERE ${keyColumn}=?` : ""} ORDER BY ordinal`, keyColumn ? [key] : []))
  const messageIdentity = (record: Recorded<Event>) => {
    if (record.message === undefined) return undefined
    const message = Schema.decodeSync(MessageMetadata, { onExcessProperty: "error" })(record.message)
    Schema.decodeUnknownSync(InboxMessageReceived, { onExcessProperty: "error" })(record.event)
    if (encoder.encode(message.id).byteLength > inlineCapacity) throw new Error("Message identity exceeds the journal row capacity")
    return message.id
  }
  for (const table of ["checkpoint", "checkpoint_trees", "effect_inputs"]) {
    if (!query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]).length) continue
    const rows = table === "checkpoint" ? query("SELECT 1 FROM checkpoint LIMIT 1") : query(`SELECT 1 FROM ${table} WHERE actor=? LIMIT 1`, [actor])
    if (rows.length) {
      const fields = query<{ name: string }>(`PRAGMA table_info(${table})`).map(row => row.name)
      const required = table === "checkpoint" ? ["position", "byte_length", "chunk_count", "digest"] : table === "checkpoint_trees" ? ["position", "commits"] : ["ref", "byte_length", "chunk_count", "digest"]
      if (required.some(field => !fields.includes(field))) throw new Error("Legacy journal data requires migration: unsupported table layout")
    }
  }
  const grove = makeSync(driver, { ...options, scope })
  const migration = journalMigration(driver, grove, actor, scope, checkpointChunkBytes, inputChunkBytes, options)
  grove.transaction(tx => {
    initializeJournal(tx, actor)
    if (options.scheduler) initializeSyncRecovery(tx)
    tx.execute("CREATE INDEX IF NOT EXISTS experimental_thread_versions ON experimental_events(actor,seq DESC) WHERE json_extract(event,'$.event.type') IN ('ThreadCreated','ThreadUpdated')", [])
    tx.execute("CREATE TABLE IF NOT EXISTS experimental_messages(actor TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(actor,id),FOREIGN KEY(actor,seq) REFERENCES experimental_events(actor,seq)) WITHOUT ROWID", [])
    if (!tx.execute("SELECT receipts_backfilled FROM journal_metadata WHERE id=1", [])[0]!.receipts_backfilled) {
      let cursor = -1
      while (true) {
        const row = query<{ seq: number; event: string }>("SELECT seq,event FROM experimental_events WHERE actor=? AND seq>? ORDER BY seq LIMIT 1", [actor, cursor])[0]
        if (!row) break
        if (!Number.isSafeInteger(row.seq) || row.seq !== cursor + 1) throw new Error("Invalid journal sequence during message index backfill")
        const record = decodeSqlJournalRecord<Event>(row.event, () => query<{ ordinal: number; payload: Uint8Array }>("SELECT ordinal,payload FROM experimental_event_chunks WHERE actor=? AND seq=? ORDER BY ordinal", [actor, row.seq]))
        const id = messageIdentity(record)
        if (id !== undefined) {
          const existing = tx.execute("SELECT seq FROM experimental_messages WHERE actor=? AND id=?", [actor, id])[0]
          if (existing && existing.seq !== row.seq) throw new Error("Message index differs from its journal record")
          if (!existing) tx.execute("INSERT INTO experimental_messages(actor,id,seq) VALUES(?,?,?)", [actor, id, row.seq])
        }
        cursor = row.seq
      }
      tx.execute("UPDATE journal_metadata SET receipts_backfilled=1 WHERE id=1", [])
    }
    migration.migrate(tx)
  })
  const session = storedSession(grove)
  const statePrefix = JSON.stringify([actor, "state"]) + "/"
  const viewPrefix = JSON.stringify([actor, "view"]) + "/"
  const inputPrefix = (key: string) => JSON.stringify([actor, "input", key]) + "/"
  const heads = new Map(grove.owners(statePrefix).map(owner => [owner.name, owner.reference]))
  let closed = false
  const guard = () => { if (closed) throw new Error("Journal is closed") }
  const attempt = <Value>(work: () => Value) => Effect.try({ try: () => { guard(); return work() }, catch: cause => cause instanceof JournalConflict ? cause : RuntimeError.from(cause) })
  const wakeLock = recoveryLock(driver.identity)
  const scheduling = options.scheduler
  const flush = options.flush ?? Effect.void
  const recovery = scheduling ? synchronousRecoveryStorage(grove, driver.identity, scheduling.alarm, flush, guard) : undefined
  const finishCommit = recovery?.finish ?? flush
  const schedulerStorage: SchedulerStorage | undefined = recovery ? { transaction: work => recovery.transaction(tx => work(tx.scheduler)) } : undefined
  const watchdogStorage: WatchdogStorage | undefined = recovery ? { transaction: work => recovery.transaction(tx => work(tx.watchdog)) } : undefined
  const scheduler = scheduling && schedulerStorage ? createScheduler({ storage: schedulerStorage, deliver: scheduling.deliver, policy: scheduling.policy }) : undefined
  const watchdog = options.watchdog && watchdogStorage ? "instance" in options.watchdog ? options.watchdog.instance : createWatchdog({ ...options.watchdog, storage: watchdogStorage }) : undefined
  const replace = (tx: Transaction, prefix: string, values: readonly string[]) => grove.replaceOwners(tx, prefix, values.map(decodeReference))
  const syncViews = (tx: Transaction) => grove.replaceOwners(tx, viewPrefix, grove.held())
  const verify = (payload: Uint8Array, digest: string | null) => Effect.gen(function* () {
    if (digest !== null && (yield* checkpointDigest(payload)) !== digest) return yield* Effect.fail(new RuntimeError("Journal payload digest mismatch"))
    return payload
  })
  const prepare = (payload: Uint8Array, size: number, inline = false) => checkpointDigest(payload).pipe(Effect.map(digest => ({ payload, digest, chunks: inline ? [] : encodeCheckpointChunks(payload, size) })))
  const append = (position: number, events: readonly Recorded<Event>[], changes: EffectInputChanges = {}, provided?: StoredCheckpoint) => Effect.gen(function* () {
    yield* attempt(() => { if (grove.transactionActive()) throw new Error("Journal append must own the native transaction") })
    const checkpoint = provided && { ...provided, payload: provided.payload.slice() }
    const batch = yield* attempt(() => ({
      documents: changes.documents && { references: changes.documents.references.map(reference => ({ ...reference })) },
      remove: changes.remove?.map(ref => ({ ...ref })),
      texts: events.map(record => { messageIdentity(record); return JSON.stringify(record) }),
      inputs: (changes.put ?? []).map(input => JSON.stringify(Schema.decodeSync(PendingEffectInput)(input))),
    }))
    if (!Number.isSafeInteger(position) || position < 0) return yield* Effect.fail(new RuntimeError("Invalid expected journal position"))
    if (checkpoint && (checkpoint.position !== position + events.length || checkpoint.digest !== (yield* checkpointDigest(checkpoint.payload)))) return yield* Effect.fail(new RuntimeError("Invalid checkpoint"))
    const saved = checkpoint ? yield* attempt(() => {
      const value = decodeCheckpoint(checkpoint.payload)
      if (value.position !== checkpoint.position) throw new Error("Checkpoint payload position mismatch")
      return value
    }) : undefined
    const encoded = yield* attempt(() => batch.texts.map(text => {
      const payload = encoder.encode(text)
      const chunks = payload.byteLength > eventInlineBytes ? encodeCheckpointChunks(payload, eventChunkBytes) : []
      const record = JSON.parse(text) as Recorded<Event> & { readonly event: { readonly type?: unknown } }
      const stored = chunks.length ? JSON.stringify({ event: typeof record.event?.type === "string" ? { type: record.event.type } : undefined, chunkCount: chunks.length, byteLength: payload.byteLength }) : text
      if (chunks.length && encoder.encode(stored).byteLength > inlineCapacity) throw new Error("Journal event metadata exceeds the row capacity")
      return { text: stored, chunks, messageId: messageIdentity(record) }
    }))
    const pending = yield* Effect.forEach(batch.inputs, text => attempt(() => {
      const input = Schema.decodeUnknownSync(PendingEffectInput)(JSON.parse(text))
      const key = effectKey(input.ref)
      return { input, key, size: inputChunkBytes(key) }
    }).pipe(Effect.flatMap(({ input, key, size }) => prepare(encoder.encode(text), size).pipe(Effect.map(value => ({ ...value, input, key }))))))
    const checkpointPayload = checkpoint ? yield* prepare(checkpoint.payload, checkpointChunkBytes) : undefined
    const context = yield* Effect.context<never>()
    yield* wakeLock.withPermit(attempt(() => {
      if (grove.transactionActive()) throw new Error("Journal append must own the native transaction")
      grove.transaction(tx => {
        const rows = tx.execute("SELECT MAX(seq) AS seq FROM experimental_events WHERE actor=?", [actor])
        const count = rows[0]?.seq === null ? 0 : Number(rows[0]?.seq) + 1
        if (count !== position) throw new JournalConflict(`Journal conflict: expected ${position}, found ${count}`)
        for (const document of batch.documents?.references ?? []) {
          const owner = statePrefix + document.name
          grove.commit(tx, { publish: [{ owner, expected: heads.get(owner) ?? null, document: decodeReference(document.reference) }] })
        }
        // syncViews retains holders acquired during payload preparation (test/bun/journal.test.ts).
        syncViews(tx)
        for (const prepared of pending) {
          const { input, key } = prepared
          if (input.ref.act !== input.request.act) throw new Error("Pending input identity mismatch")
          const existing = query<StoredPayloadRow>("SELECT input AS payload,byte_length,chunk_count,digest FROM journal_accepted_inputs WHERE ref=?", [key])[0]
          if (existing !== undefined) {
            const payload = bytes(existing, "journal_accepted_input_chunks", "ref", key)
            if (existing.digest !== null && storedPayloadDigest(payload) !== existing.digest) throw new Error("Accepted input digest mismatch")
            if (!isDeepStrictEqual(JSON.parse(decoder.decode(payload)), input)) throw new Error("Accepted effect input cannot change")
            continue
          }
          replace(tx, inputPrefix(key), input.request.selections?.map(selection => selection.reference) ?? [])
          tx.execute("INSERT INTO journal_accepted_inputs(ref,input,byte_length,chunk_count,digest) VALUES(?,?,?,?,?)", [key, "", prepared.payload.byteLength, prepared.chunks.length, prepared.digest])
          for (const chunk of prepared.chunks) tx.execute("INSERT INTO journal_accepted_input_chunks VALUES(?,?,?)", [key, chunk.ordinal, chunk.payload])
        }
        for (const [index, record] of encoded.entries()) {
          tx.execute("INSERT INTO experimental_events(actor,seq,event) VALUES(?,?,?)", [actor, position + index, record.text])
          for (const chunk of record.chunks) tx.execute("INSERT INTO experimental_event_chunks VALUES(?,?,?,?)", [actor, position + index, chunk.ordinal, chunk.payload])
          const id = record.messageId
          if (id !== undefined) tx.execute("INSERT INTO experimental_messages(actor,id,seq) VALUES(?,?,?)", [actor, id, position + index])
        }
        for (const ref of batch.remove ?? []) {
          const key = effectKey(ref)
          replace(tx, inputPrefix(key), [])
          tx.execute("DELETE FROM journal_accepted_input_chunks WHERE ref=?", [key])
          tx.execute("DELETE FROM journal_accepted_inputs WHERE ref=?", [key])
        }
        if (checkpoint) {
          replace(tx, JSON.stringify([actor, "checkpoint"]) + "/", [...saved!.durable.flatMap(entry => entry.reference ? [entry.reference] : []), ...saved!.operations.flatMap(operation => Object.values(operation.execution.results ?? {}))])
          tx.execute("DELETE FROM journal_checkpoint_chunks", [])
          tx.execute("INSERT INTO journal_checkpoints(id,position,payload,digest,byte_length,chunk_count) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,payload=excluded.payload,digest=excluded.digest,byte_length=excluded.byte_length,chunk_count=excluded.chunk_count", [checkpoint.position, new Uint8Array(), checkpoint.digest, checkpoint.payload.byteLength, checkpointPayload!.chunks.length])
          for (const chunk of checkpointPayload!.chunks) tx.execute("INSERT INTO journal_checkpoint_chunks VALUES(?,?)", [chunk.ordinal, chunk.payload])
        }
        if (scheduling) {
          const recovery = syncRecoveryTransaction(tx, scheduling.alarm)
          const records = batch.texts.map(text => JSON.parse(text) as Recorded<Event>)
          Effect.runSyncWith(context)(Effect.gen(function* () {
            yield* recordRetryWakes(recovery.scheduler, records)
            if (watchdog && options.watchdog && records.length) {
              let progressCursor = 0, admission = false
              for (const [index, { event }] of records.entries()) {
                if (Schema.is(ThreadUpdated)(event)) yield* watchdog.adoptVersion(recovery.watchdog, options.watchdog.target, event.version)
                if ("type" in event && (event.type === "EffectSettled" || event.type === "PromiseSettled")) progressCursor = position + index + 1
                if ("type" in event && ["MessageReceived", "ThreadCreated", "ThreadRequested", "EffectCancelled"].includes(String(event.type))) admission = true
              }
              yield* watchdog.admit(recovery.watchdog, options.watchdog.target, progressCursor, admission)
            }
          }))
        }
        if (checkpoint && options.collectEvery !== undefined) {
          const row = tx.execute("UPDATE journal_metadata SET checkpoints=checkpoints+1 WHERE id=1 RETURNING checkpoints", [])[0]!
          if (Number(row.checkpoints) % options.collectEvery === 0) grove.collect()
        }
      })
      for (const document of batch.documents?.references ?? []) heads.set(statePrefix + document.name, decodeReference(document.reference))
      grove.discard()
    }).pipe(Effect.andThen(finishCommit), Effect.uninterruptible))
  })
  const captureRecord = (row: { readonly seq: number; readonly event: string }) => {
    if (!Number.isSafeInteger(row.seq) || row.seq < 0) throw new Error("Invalid journal sequence")
    return { seq: row.seq, record: migration.event(decodeSqlJournalRecord<Event>(row.event, () => query<{ ordinal: number; payload: Uint8Array }>("SELECT ordinal,payload FROM experimental_event_chunks WHERE actor=? AND seq=? ORDER BY ordinal", [actor, row.seq]))) }
  }
  const readAfter = (position: number) => Effect.gen(function* () {
    if (scheduler) yield* scheduler.restore
    return yield* attempt(() => grove.transaction(() => {
      const count = Number(query<{ count: number }>("SELECT COUNT(*) count FROM experimental_events WHERE actor=?", [actor])[0]!.count)
      if (!Number.isSafeInteger(position) || position < 0 || position > count) throw new Error("Invalid journal suffix position")
      return query<{ seq: number; event: string }>("SELECT seq,event FROM experimental_events WHERE actor=? AND seq>=? ORDER BY seq", [actor, position]).map((row, index) => {
        if (row.seq !== position + index) throw new Error("Invalid journal sequence")
        return captureRecord(row).record
      })
    }))
  })
  const decodeRecord = (row: ReturnType<typeof captureRecord>) => attempt(() => row.record)
  const journal: MessageJournal<Event> = {
    storedValues: session, read: readAfter(0), readAfter,
    acknowledge: wakeLock.withPermit(attempt(guard).pipe(Effect.andThen(finishCommit), Effect.uninterruptible)),
    readMessage: id => Effect.gen(function* () {
      const row = yield* attempt(() => grove.transaction(() => {
        const row = query<{ seq: number | null; event: string }>("SELECT e.seq,e.event FROM experimental_messages m LEFT JOIN experimental_events e ON e.actor=m.actor AND e.seq=m.seq WHERE m.actor=? AND m.id=?", [actor, id])[0]
        if (!row) return undefined
        if (row.seq === null) throw new Error("Message index references a missing journal record")
        return captureRecord({ ...row, seq: row.seq })
      }))
      if (!row) return undefined
      const record = yield* decodeRecord(row)
      yield* attempt(() => { if (messageIdentity(record) !== id) throw new Error("Message index differs from its journal record") })
      return { position: row.seq + 1, record }
    }),
    readInputs: Effect.gen(function* () {
      const rows = yield* attempt(() => grove.transaction(() => query<StoredPayloadRow & { ref: string }>("SELECT ref,input AS payload,byte_length,chunk_count,digest FROM journal_accepted_inputs ORDER BY ref", []).map(row => ({ ...row, payload: bytes(row, "journal_accepted_input_chunks", "ref", row.ref) }))))
      return yield* Effect.forEach(rows, row => verify(row.payload, row.digest).pipe(Effect.flatMap(payload => attempt(() => {
        const input = Schema.decodeUnknownSync(PendingEffectInput)(JSON.parse(decoder.decode(payload)))
        if (effectKey(input.ref) !== row.ref || input.ref.act !== input.request.act) throw new Error("Pending input identity mismatch")
        return input
      }))))
    }),
    append,
    appendWithCheckpoint: (position, events, checkpoint, changes) => append(position, events, changes, checkpoint),
    readCheckpoint: Effect.gen(function* () {
      const row = yield* attempt(() => grove.transaction(() => {
        const row = query<StoredPayloadRow & { position: number }>("SELECT position,payload,digest,byte_length,chunk_count FROM journal_checkpoints WHERE id=1", [])[0]
        return row && { ...row, payload: bytes(row, "journal_checkpoint_chunks", "", "") }
      }))
      if (!row) return undefined
      if (row.digest === null) return yield* Effect.fail(new RuntimeError("Missing checkpoint digest"))
      yield* verify(row.payload, row.digest)
      return { position: row.position, payload: row.payload, digest: row.digest }
    }),
  }
  return { ...journal, storedValues: session, grove, scope, scheduler, watchdog, watchdogStorage,
    readFirst: Effect.gen(function* () {
      const row = yield* attempt(() => grove.transaction(() => {
        const row = query<{ seq: number; event: string }>("SELECT seq,event FROM experimental_events WHERE actor=? ORDER BY seq LIMIT 1", [actor])[0]
        if (!row) return undefined
        if (row.seq !== 0) throw new Error("Invalid first journal sequence")
        return captureRecord(row)
      }))
      return row ? yield* decodeRecord(row) : undefined
    }),
    readVersion: Effect.gen(function* () {
      const snapshot = yield* attempt(() => grove.transaction(() => {
        const head = query<{ seq: number | null }>("SELECT MAX(seq) seq FROM experimental_events WHERE actor=?", [actor])[0]!
        const position = head.seq === null ? 0 : head.seq + 1
        if (!Number.isSafeInteger(position) || position < 0) throw new Error("Invalid journal position")
        const row = query<{ seq: number; event: string }>("SELECT seq,event FROM experimental_events WHERE actor=? AND json_extract(event,'$.event.type') IN ('ThreadCreated','ThreadUpdated') ORDER BY seq DESC LIMIT 1", [actor])[0]
        const pendingEffects = Number(query<{ n: number }>("SELECT COUNT(*) n FROM journal_accepted_inputs", [])[0]!.n)
        return { position, pendingEffects, row: row && captureRecord(row) }
      }))
      if (!snapshot.row) return { position: snapshot.position, pendingEffects: snapshot.pendingEffects }
      const record = yield* decodeRecord(snapshot.row)
      const lifecycle = yield* attempt(() => Schema.decodeUnknownSync(Schema.Union([ThreadCreated, ThreadUpdated]))(record.event))
      return { position: snapshot.position, pendingEffects: snapshot.pendingEffects, ...(lifecycle.version === undefined ? {} : { version: lifecycle.version }) }
    }),
    chunking: { checkpointChunkBytes, eventChunkBytes, eventInlineBytes, maxRowBytes, inputChunkBytes }, collection: { everyCheckpoints: options.collectEvery },
    collect: attempt(() => grove.transaction(tx => { syncViews(tx); return grove.collect() })),
    close: wakeLock.withPermit(Effect.try({ try: () => {
      if (closed) return
      grove.transaction(tx => syncViews(tx))
      closed = true
    }, catch: RuntimeError.from })),
  }
}
