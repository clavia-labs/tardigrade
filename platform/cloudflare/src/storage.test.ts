import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { threadKeys } from "@clavia/tardigrade-core/interaction/relations"
import { CloudflareEventStore, hmacSha256EventKeyIndex, plaintextEventCodec, plaintextEventKeyIndex } from "./storage"

const directory = mkdtempSync(join(tmpdir(), "tardigrade-cf-storage-"))
let sequence = 0
const freshPath = (): string => join(directory, `store-${sequence++}.sqlite`)

const open = async (path: string, indexKey: CloudflareEventStore["indexKey"] = plaintextEventKeyIndex) => {
  const runtime = ManagedRuntime.make(SqliteClient.layer({ filename: path }))
  const sql = await runtime.runPromise(SqlClient.SqlClient)
  const subjectsOf = (event: Event): ReadonlyArray<string> =>
    event.type === "Snapshot" ? ["snapshot:latest", `snapshot:${String(event.kind)}`] : []
  return {
    store: new CloudflareEventStore(sql, threadKeys.keyOf, plaintextEventCodec, indexKey, subjectsOf),
    dispose: () => runtime.dispose()
  }
}

const created: Event = { type: "ThreadCreated", address: { actor: "echo", instance: "main", thread: "t1" }, depth: 0, at: 0 }
const snapshot = (kind: string, at: number): Event => ({ type: "Snapshot", kind, at })

describe("CloudflareEventStore facts", () => {
  test("batch lookup deduplicates shared events and sorts by sequence", async () => {
    const opened = await open(freshPath())
    await Effect.runPromise(opened.store.initialize())
    await Effect.runPromise(opened.store.append([created, snapshot("first", 1), snapshot("latest", 2)]))
    expect(await Effect.runPromise(opened.store.readSubjects([
      "snapshot:latest",
      "snapshot:first",
      "snapshot:latest",
      "snapshot:missing"
    ]))).toEqual([
      { seq: 2, event: snapshot("first", 1) },
      { seq: 3, event: snapshot("latest", 2) }
    ])
    await opened.dispose()
  })

  test("a pre-existing log answers indexed facts after upgrade", async () => {
    // A database from before the subject tables: the old schema, its migrations recorded, and
    // events the index has never seen.
    const path = freshPath()
    const old = new Database(path)
    try {
      old.exec(`CREATE TABLE events (
        seq INTEGER NOT NULL,
        key TEXT,
        event TEXT NOT NULL,
        PRIMARY KEY (seq)
      ) WITHOUT ROWID`)
      old.exec("CREATE UNIQUE INDEX events_key ON events (key) WHERE key IS NOT NULL")
      old.exec(`CREATE TABLE effect_sql_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`)
      old.run("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'thread_identity')")
      old.run("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (2, 'thread_events')")
      old.run("INSERT INTO events (seq, key, event) VALUES (1, ?, ?)", ["thread:created", JSON.stringify(created)])
      old.run("INSERT INTO events (seq, key, event) VALUES (2, NULL, ?)", [JSON.stringify(snapshot("first", 1))])
      old.run("INSERT INTO events (seq, key, event) VALUES (3, NULL, ?)", [JSON.stringify(snapshot("latest", 2))])
    } finally {
      old.close()
    }
    const opened = await open(path)
    await Effect.runPromise(opened.store.initialize())
    expect(await Effect.runPromise(opened.store.readSubjects(["snapshot:first", "snapshot:latest"]))).toEqual([
      { seq: 2, event: snapshot("first", 1) },
      { seq: 3, event: snapshot("latest", 2) }
    ])
    await opened.dispose()
  })

  test("sealed stores never persist readable subjects", async () => {
    const path = freshPath()
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("abcdef0123456789abcdef0123456789"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    const opened = await open(path, hmacSha256EventKeyIndex(key, "main:t1"))
    await Effect.runPromise(opened.store.initialize())
    await Effect.runPromise(opened.store.append([created, snapshot("latest", 1)]))
    const raw = new Database(path, { readonly: true })
    try {
      const subjects = raw.query("SELECT subject FROM event_subjects").all() as ReadonlyArray<{ readonly subject: string }>
      expect(subjects.every((row) => /^hmac-sha256:[a-f0-9]{64}$/.test(row.subject))).toBe(true)
    } finally {
      raw.close()
    }
    expect(await Effect.runPromise(opened.store.readSubjects(["snapshot:latest"]))).toEqual([{ seq: 2, event: snapshot("latest", 1) }])
    await opened.dispose()
  })
})
