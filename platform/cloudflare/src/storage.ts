import { Effect, Encoding, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { SqlClient } from "effect/unstable/sql"
import { SqliteMigrator } from "@effect/sql-sqlite-do"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { AppendResult, ThreadEventStore } from "@clavia/tardigrade-core/log"

export interface EventRow {
  readonly seq: number
  readonly event: Event
}

export type CloudflareEventKeyIndex = (key: string) => Effect.Effect<string>

export interface CloudflareEventCodec {
  readonly encode: (events: ReadonlyArray<Event>) => Effect.Effect<ReadonlyArray<Event>>
  readonly decode: (events: ReadonlyArray<Event>) => Effect.Effect<ReadonlyArray<Event>>
}

export interface CloudflareThreadStorePolicy {
  readonly codec: CloudflareEventCodec
  readonly indexKey: CloudflareEventKeyIndex
}

export const plaintextEventCodec: CloudflareEventCodec = {
  encode: Effect.succeed,
  decode: Effect.succeed
}

export const plaintextEventKeyIndex: CloudflareEventKeyIndex = Effect.succeed

export const hmacSha256EventKeyIndex = (
  key: CryptoKey | Promise<CryptoKey>,
  binding: string
): CloudflareEventKeyIndex => (value) => Effect.promise(async () => {
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    await key,
    new TextEncoder().encode(JSON.stringify([binding, value]))
  ))
  const digest = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `hmac-sha256:${digest}`
})

const actorMigrations = SqliteMigrator.fromRecord({
  "0001_actor_runtime": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE actor_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      actor TEXT NOT NULL,
      instance TEXT NOT NULL
    )`)
    yield* sql.unsafe(`CREATE TABLE events (
      seq INTEGER NOT NULL,
      key TEXT,
      event TEXT NOT NULL,
      PRIMARY KEY (seq)
    ) WITHOUT ROWID`)
    yield* sql.unsafe("CREATE UNIQUE INDEX events_key ON events (key) WHERE key IS NOT NULL")
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
  initializeDatabase(threadMigrations)

// CloudflareEventStore binds the event-log guarantees to an Effect SQL client over one Durable Object database.
export class CloudflareEventStore implements ThreadEventStore {
  readonly sql: SqlClient.SqlClient
  readonly keyOf: (event: Event) => string | undefined
  readonly codec: CloudflareEventCodec
  readonly indexKey: CloudflareEventKeyIndex

  constructor(
    sql: SqlClient.SqlClient,
    keyOf: (event: Event) => string | undefined,
    codec: CloudflareEventCodec = plaintextEventCodec,
    indexKey: CloudflareEventKeyIndex = plaintextEventKeyIndex
  ) {
    this.sql = sql
    this.keyOf = keyOf
    this.codec = codec
    this.indexKey = indexKey
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
        Effect.flatMap((events) => this.decode(events)),
        Effect.orDie
      )
  }

  readFrom(mark: number): Effect.Effect<ReadonlyArray<Event>> {
    return this.sql
      .unsafe<{ readonly event: string }>("SELECT event FROM events WHERE seq > ? ORDER BY seq", [mark])
      .pipe(
        Effect.map((rows) => rows.map((row) => JSON.parse(row.event) as Event)),
        Effect.flatMap((events) => this.decode(events)),
        Effect.orDie
      )
  }

  readPage(mark: number, limit: number): Effect.Effect<ReadonlyArray<EventRow>> {
    return this.sql
      .unsafe<{ readonly seq: number; readonly event: string }>(
        "SELECT seq, event FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
        [mark, limit]
      )
      .pipe(
        Effect.flatMap((rows) => {
          const events = rows.map((row) => JSON.parse(row.event) as Event)
          return this.decode(events).pipe(
            Effect.map((decoded) => rows.map((row, index) => ({ seq: Number(row.seq), event: decoded[index]! })))
          )
        }),
        Effect.orDie
      )
  }

  private decode(events: ReadonlyArray<Event>): Effect.Effect<ReadonlyArray<Event>> {
    return this.codec.decode(events).pipe(
      Effect.flatMap((decoded) => decoded.length === events.length
        ? Effect.succeed(decoded)
        : Effect.die(new Error("event codec decode must preserve batch length")))
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

  append(events: ReadonlyArray<Event>): Effect.Effect<AppendResult> {
    if (events.length === 0) return Effect.map(this.head, (head) => ({ appended: 0, head }))
    const sql = this.sql
    const keyOf = this.keyOf
    const codec = this.codec
    const indexKey = this.indexKey
    return Effect.gen(function* () {
      const indexedKeys = yield* Effect.forEach(events, (event) => {
        const eventKey = keyOf(event)
        return eventKey === undefined ? Effect.void : indexKey(eventKey)
      })
      const encoded = yield* codec.encode(events)
      if (encoded.length !== events.length) {
        return yield* Effect.die(new Error("event codec encode must preserve batch length"))
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const heads = yield* sql.unsafe<{ readonly head: number }>(
            "SELECT COALESCE(MAX(seq), 0) AS head FROM events"
          )
          const currentHead = Number(heads[0]?.head ?? 0)
          let seq = currentHead + 1
          let appended = 0
          for (let index = 0; index < encoded.length; index++) {
            const event = encoded[index]!
            const indexedKey = indexedKeys[index]
            if (indexedKey !== undefined) {
              const present = yield* sql.unsafe<{ readonly present: number }>(
                "SELECT 1 AS present FROM events WHERE key = ?",
                [indexedKey]
              )
              if (present.length > 0) continue
            }
            yield* sql.unsafe(
              "INSERT INTO events (seq, key, event) VALUES (?, ?, ?)",
              [seq, indexedKey ?? null, JSON.stringify(event)]
            )
            seq += 1
            appended += 1
          }
          return { appended, head: seq - 1 }
        })
      )
    }).pipe(Effect.orDie)
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
