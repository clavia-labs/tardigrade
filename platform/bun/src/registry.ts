import { Effect, ManagedRuntime, type Scope } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { ActorRegistration, ActorRegistry } from "@clavia/tardigrade-core/actor-registry"

// DEFAULT_ACTOR_REGISTRY_TABLE is the table used when a Bun registry does not select another table.
export const DEFAULT_ACTOR_REGISTRY_TABLE = "actor_registry"

export interface BunActorRegistryOptions<Registration extends ActorRegistration> {
  readonly sql: SqlClient.SqlClient
  readonly table?: string
  readonly decode?: (encoded: string) => Registration
  readonly encode?: (registration: Registration) => string
}

export interface BunActorRegistryFileOptions<Registration extends ActorRegistration> {
  readonly file: string
  readonly table?: string
  readonly decode?: (encoded: string) => Registration
  readonly encode?: (registration: Registration) => string
}

const tableOf = (table: string | undefined): string => {
  const selected = table ?? DEFAULT_ACTOR_REGISTRY_TABLE
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(selected)) throw new Error(`actor registry table is not a SQL identifier: ${JSON.stringify(selected)}`)
  return selected
}

// makeBunActorRegistry stores actor records in the supplied SQLite client.
export const makeBunActorRegistry = <Registration extends ActorRegistration>(
  options: BunActorRegistryOptions<Registration>
): Effect.Effect<ActorRegistry<Registration>> => {
  const table = tableOf(options.table)
  const decode = options.decode ?? ((encoded: string) => JSON.parse(encoded) as Registration)
  const encode = options.encode ?? JSON.stringify
  const sql = options.sql
  const checked = (name: string, encoded: string): Registration => {
    const registration = decode(encoded)
    if (registration.name !== name) throw new Error(`actor registry record ${JSON.stringify(name)} contains name ${JSON.stringify(registration.name)}`)
    return registration
  }
  return sql.unsafe(
    `CREATE TABLE IF NOT EXISTS ${table} (
      name TEXT PRIMARY KEY,
      registration TEXT NOT NULL
    ) WITHOUT ROWID`
  ).pipe(
    Effect.as({
      resolve: (name: string) => sql.unsafe<{ readonly name: string; readonly registration: string }>(
        `SELECT name, registration FROM ${table} WHERE name = ?`,
        [name]
      ).pipe(
        Effect.map((rows) => rows[0] === undefined ? undefined : checked(rows[0].name, rows[0].registration)),
        Effect.orDie
      ),
      list: sql.unsafe<{ readonly name: string; readonly registration: string }>(
        `SELECT name, registration FROM ${table} ORDER BY name`
      ).pipe(
        Effect.map((rows) => rows.map((row) => checked(row.name, row.registration))),
        Effect.orDie
      ),
      put: (registration: Registration) => {
        if (registration.name.length === 0) return Effect.die(new Error("actor registry name must not be empty"))
        return sql.unsafe(
          `INSERT INTO ${table} (name, registration) VALUES (?, ?)
           ON CONFLICT(name) DO UPDATE SET registration = excluded.registration`,
          [registration.name, encode(registration)]
        ).pipe(Effect.asVoid, Effect.orDie)
      },
      remove: (name: string) => sql.unsafe(`DELETE FROM ${table} WHERE name = ?`, [name]).pipe(Effect.asVoid, Effect.orDie)
    } satisfies ActorRegistry<Registration>),
    Effect.orDie
  )
}

// openBunActorRegistry acquires a SQLite-backed registry and closes its client with the surrounding scope.
export const openBunActorRegistry = <Registration extends ActorRegistration>(
  options: BunActorRegistryFileOptions<Registration>
): Effect.Effect<ActorRegistry<Registration>, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (options.file !== "" && options.file !== ":memory:") yield* Effect.promise(() => mkdir(dirname(options.file), { recursive: true }))
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(SqliteClient.layer({ filename: options.file }))),
      (acquired) => Effect.promise(() => acquired.dispose())
    )
    const sql = yield* Effect.promise(() => runtime.runPromise(SqliteClient.SqliteClient))
    return yield* makeBunActorRegistry({
      sql,
      ...(options.table === undefined ? {} : { table: options.table }),
      ...(options.decode === undefined ? {} : { decode: options.decode }),
      ...(options.encode === undefined ? {} : { encode: options.encode })
    })
  })
