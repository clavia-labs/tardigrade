import { Database } from "bun:sqlite"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { Effect, type Schema } from "effect"
import { RuntimeError, type Recorded } from "@clavia/tardigrade-core"
import { createJournalStore, createSupervisorStore, createThreadStore, SupervisorEvent, type ThreadCoordinate } from "@clavia/tardigrade-core"

import { decodeSqlJournalRecord } from "../shared/sql-journal"
import type { CheckpointChunk } from "../shared/checkpoint-chunks"
import { storedPayloadBytes, storedPayloadDigest, type StoredPayloadRow, type StoredPayloadChunk } from "../shared/stored-journal-payloads"

const encoded = (value: string) => Buffer.from(value).toString("base64url")
export const bunSupervisorPath = (storage: string, actor: string, instance: string) => join(storage, `${encoded(JSON.stringify([actor, instance]))}.sqlite`)
export const bunThreadPath = (storage: string, coordinate: ThreadCoordinate) => join(`${bunSupervisorPath(storage, coordinate.actor, coordinate.instance)}.threads`, `${encoded(coordinate.thread)}.sqlite`)

function reader<Event extends object>(filename: string, actor: string) {
  return (after: number): Effect.Effect<readonly Recorded<Event>[], Error> => Effect.try({ try: () => {
    if (!existsSync(filename)) return []
    const database = new Database(filename, { readonly: true })
    try {
      const legacy = database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='experimental_events'").get()
      const stored = database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='stored_journal_events'").get()
      const hasStored = stored && database.query("SELECT seq FROM stored_journal_events WHERE actor=? LIMIT 1").get(actor)
      if (hasStored && legacy && database.query("SELECT seq FROM experimental_events WHERE actor=? LIMIT 1").get(actor)) throw new RuntimeError("Mixed journal formats require migration")
      if (stored && (hasStored || !legacy)) return database.transaction(() => database.query<StoredPayloadRow & { seq: number }, [string, number]>("SELECT seq,record AS payload,byte_length,chunk_count,digest FROM stored_journal_events WHERE actor=? AND seq>? ORDER BY seq").all(actor, after).map((row, index) => {
        if (row.seq !== after + index + 1) throw new RuntimeError("Invalid journal sequence")
        const payload = storedPayloadBytes(row, () => database.query<StoredPayloadChunk, [string, number]>("SELECT ordinal,payload FROM stored_journal_event_chunks WHERE actor=? AND seq=? ORDER BY ordinal").all(actor, row.seq))
        if (row.digest !== null && storedPayloadDigest(payload) !== row.digest) throw new RuntimeError("Journal payload digest mismatch")
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as Recorded<Event>
      }))()
      if (!legacy) return []
      return database.query<{ seq: number; event: string }, [string, number]>("SELECT seq, event FROM experimental_events WHERE actor = ? AND seq > ? ORDER BY seq").all(actor, after).map((row, index) => {
        if (row.seq !== after + index + 1) throw new RuntimeError("Invalid journal sequence")
        return decodeSqlJournalRecord<Event>(row.event, () => database.query<CheckpointChunk, [string, number]>("SELECT ordinal, payload FROM experimental_event_chunks WHERE actor = ? AND seq = ? ORDER BY ordinal").all(actor, row.seq))
      })
    } finally { database.close() }
  }, catch: RuntimeError.from })
}

// observeBunThread reads committed events and projections without starting the actor.
export function observeBunThread<Event extends object>(options: { readonly storage: string; readonly coordinate: ThreadCoordinate; readonly schema: Schema.Schema<Event> }) {
  const journal = createJournalStore({ schema: options.schema, read: reader<Event>(bunThreadPath(options.storage, options.coordinate), "events") })
  return { ...createThreadStore(options.coordinate, journal), events: journal.events, records: journal.records, refresh: journal.refresh, close: journal.close }
}

// observeBunSupervisor reads the thread directory without provisioning threads.
export function observeBunSupervisor(options: { readonly storage: string; readonly actor: string; readonly instance: string }) {
  const journal = createJournalStore({ schema: SupervisorEvent, read: reader<SupervisorEvent>(bunSupervisorPath(options.storage, options.actor, options.instance), "supervisor") })
  return { ...createSupervisorStore(journal), refresh: journal.refresh, close: journal.close }
}

// bunThreadActivity returns SQLite file activity time, or undefined when the thread has no database.
export function bunThreadActivity(storage: string, coordinate: ThreadCoordinate): number | undefined {
  const filename = bunThreadPath(storage, coordinate)
  const times = [filename, `${filename}-wal`].map(path => statSync(path, { throwIfNoEntry: false })?.mtimeMs).filter((time): time is number => time !== undefined)
  return times.length ? Math.max(...times) : undefined
}
