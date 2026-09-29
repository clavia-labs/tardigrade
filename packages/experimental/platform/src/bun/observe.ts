import { Database } from "bun:sqlite"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { Effect, type Schema } from "effect"
import { RuntimeError, type Recorded } from "@clavia/tardigrade-experimental-core"
import { createJournalStore, createSupervisorStore, createThreadStore, SupervisorEvent, type ThreadCoordinate } from "@clavia/tardigrade-experimental-host"

const encoded = (value: string) => Buffer.from(value).toString("base64url")
export const bunSupervisorPath = (storage: string, actor: string, instance: string) => join(storage, `${encoded(JSON.stringify([actor, instance]))}.sqlite`)
export const bunThreadPath = (storage: string, coordinate: ThreadCoordinate) => join(`${bunSupervisorPath(storage, coordinate.actor, coordinate.instance)}.threads`, `${encoded(coordinate.thread)}.sqlite`)

function reader<Event extends object>(filename: string, actor: string) {
  return (after: number): Effect.Effect<readonly Recorded<Event>[], Error> => Effect.try({ try: () => {
    if (!existsSync(filename)) return []
    const database = new Database(filename, { readonly: true })
    try {
      if (!database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'experimental_events'").get()) return []
      return database.query<{ seq: number; event: string }, [string, number]>("SELECT seq, event FROM experimental_events WHERE actor = ? AND seq > ? ORDER BY seq").all(actor, after).map((row, index) => {
        if (row.seq !== after + index + 1) throw new RuntimeError("Invalid journal sequence")
        return JSON.parse(row.event) as Recorded<Event>
      })
    } finally { database.close() }
  }, catch: RuntimeError.from })
}

// observeBunThread reads committed events and projections without starting the actor.
export function observeBunThread<Event extends object>(options: { readonly storage: string; readonly coordinate: ThreadCoordinate; readonly schema: Schema.Schema<Event> }) {
  const journal = createJournalStore({ schema: options.schema, read: reader<Event>(bunThreadPath(options.storage, options.coordinate), "events") })
  return { ...createThreadStore(options.coordinate, journal), events: journal.events, refresh: journal.refresh, close: journal.close }
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
