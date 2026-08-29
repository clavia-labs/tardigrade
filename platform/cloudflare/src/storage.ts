import { Effect, Encoding, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { SqlClient } from "effect/unstable/sql"
import { SqliteMigrator } from "@effect/sql-sqlite-do"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ThreadEventStore } from "@clavia/tardigrade-core/log"

export interface EventRow {
  readonly seq: number
  readonly event: Event
}

const actorMigrations = SqliteMigrator.fromRecord({
  "0001_actor_directory": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE actor_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      actor TEXT NOT NULL,
      instance TEXT NOT NULL
    )`)
    yield* sql.unsafe(`CREATE TABLE thread_directory (
      thread TEXT PRIMARY KEY,
      parent_thread TEXT,
      depth INTEGER NOT NULL,
      placement TEXT
    ) WITHOUT ROWID`)
  })
})

const createThreadIdentity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE thread_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    actor TEXT NOT NULL,
    instance TEXT NOT NULL,
    thread TEXT NOT NULL
  )`)
})

const threadIdentityMigrations = SqliteMigrator.fromRecord({
  "0001_thread_identity": createThreadIdentity
})

const threadMigrations = SqliteMigrator.fromRecord({
  "0001_thread_identity": createThreadIdentity,
  "0002_thread_events": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE events (
      seq INTEGER NOT NULL,
      key TEXT,
      event TEXT NOT NULL,
      PRIMARY KEY (seq)
    ) WITHOUT ROWID`)
    yield* sql.unsafe("CREATE UNIQUE INDEX events_key ON events (key) WHERE key IS NOT NULL")
  })
})

const initializeDatabase = (loader: SqliteMigrator.Loader): Effect.Effect<void, never, SqlClient.SqlClient> =>
  SqliteMigrator.run({ loader }).pipe(Effect.asVoid, Effect.orDie)

export const initializeCloudflareActorSchema: Effect.Effect<void, never, SqlClient.SqlClient> =
  initializeDatabase(actorMigrations)

export const initializeCloudflareThreadSchema: Effect.Effect<void, never, SqlClient.SqlClient> =
  initializeDatabase(threadIdentityMigrations)

// CloudflareEventStore binds the event-log guarantees to an Effect SQL client over one Durable Object database.
export class CloudflareEventStore implements ThreadEventStore {
  readonly sql: SqlClient.SqlClient
  readonly keyOf: (event: Event) => string | undefined

  constructor(sql: SqlClient.SqlClient, keyOf: (event: Event) => string | undefined) {
    this.sql = sql
    this.keyOf = keyOf
  }

  initialize(): Effect.Effect<void> {
    return initializeDatabase(threadMigrations).pipe(
      Effect.provideService(SqlClient.SqlClient, this.sql)
    )
  }

  get read(): Effect.Effect<ReadonlyArray<Event>> {
    return this.sql
      .unsafe<{ readonly event: string }>("SELECT event FROM events ORDER BY seq")
      .pipe(
        Effect.map((rows) => rows.map((row) => JSON.parse(row.event) as Event)),
        Effect.orDie
      )
  }

  readFrom(mark: number): Effect.Effect<ReadonlyArray<Event>> {
    return this.sql
      .unsafe<{ readonly event: string }>("SELECT event FROM events WHERE seq > ? ORDER BY seq", [mark])
      .pipe(
        Effect.map((rows) => rows.map((row) => JSON.parse(row.event) as Event)),
        Effect.orDie
      )
  }

  get head(): Effect.Effect<number> {
    return this.sql
      .unsafe<{ readonly head: number }>("SELECT COALESCE(MAX(seq), 0) AS head FROM events")
      .pipe(
        Effect.map((rows) => Number(rows[0]?.head ?? 0)),
        Effect.orDie
      )
  }

  append(events: ReadonlyArray<Event>): Effect.Effect<number> {
    if (events.length === 0) return Effect.succeed(0)
    const sql = this.sql
    const keyOf = this.keyOf
    return sql.withTransaction(
      Effect.gen(function* () {
        const heads = yield* sql.unsafe<{ readonly head: number }>(
          "SELECT COALESCE(MAX(seq), 0) AS head FROM events"
        )
        let seq = Number(heads[0]?.head ?? 0) + 1
        let appended = 0
        for (const event of events) {
          const key = keyOf(event)
          if (key !== undefined) {
            const present = yield* sql.unsafe<{ readonly present: number }>(
              "SELECT 1 AS present FROM events WHERE key = ?",
              [key]
            )
            if (present.length > 0) continue
          }
          yield* sql.unsafe(
            "INSERT INTO events (seq, key, event) VALUES (?, ?, ?)",
            [seq, key ?? null, JSON.stringify(event)]
          )
          seq += 1
          appended += 1
        }
        return appended
      })
    ).pipe(Effect.orDie)
  }
}

// layerWorkspace binds Effect's workspace store to the actor database through Effect SQL.
export const layerWorkspace = (sql: SqlClient.SqlClient): Layer.Layer<KeyValueStore.KeyValueStore> => {
  const get = (key: string): Effect.Effect<string | undefined> =>
    sql.unsafe<{ readonly value: string }>("SELECT value FROM workspace WHERE key = ?", [key]).pipe(
      Effect.map((rows) => rows[0]?.value),
      Effect.orDie
    )
  const set = (key: string, value: string): Effect.Effect<void> =>
    sql.unsafe(
      "INSERT INTO workspace (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value]
    ).pipe(Effect.asVoid, Effect.orDie)
  const initialize = sql.unsafe(
    `CREATE TABLE IF NOT EXISTS workspace (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID`
  ).pipe(Effect.asVoid, Effect.orDie)
  const store = KeyValueStore.make({
    get,
    getUint8Array: (key) => get(key).pipe(Effect.map((value) => {
      if (value === undefined) return undefined
      const decoded = Encoding.decodeBase64(value)
      return decoded._tag === "Success" ? decoded.success : new TextEncoder().encode(value)
    })),
    set: (key, value) => set(key, typeof value === "string" ? value : Encoding.encodeBase64(value)),
    remove: (key) => sql.unsafe("DELETE FROM workspace WHERE key = ?", [key]).pipe(Effect.asVoid, Effect.orDie),
    clear: sql.unsafe("DELETE FROM workspace").pipe(Effect.asVoid, Effect.orDie),
    size: sql.unsafe<{ readonly count: number }>("SELECT COUNT(*) AS count FROM workspace").pipe(
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
      Effect.orDie
    ),
    modify: (key, f) => sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* get(key)
        if (current === undefined) return undefined
        const next = f(current)
        yield* set(key, next)
        return next
      })
    ).pipe(Effect.orDie)
  })
  return Layer.effect(KeyValueStore.KeyValueStore, Effect.as(initialize, store))
}
