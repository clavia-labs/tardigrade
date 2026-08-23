import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { D1Client } from "@effect/sql-d1"
import type { ActorRegistration, ActorRegistry } from "@clavia/tardigrade-core/actor-registry"

// DEFAULT_ACTOR_REGISTRY_TABLE is the D1 table used when a Cloudflare registry does not select another table.
export const DEFAULT_ACTOR_REGISTRY_TABLE = "actor_registry"

export interface CloudflareActorRegistration extends ActorRegistration {
  readonly assembly: string
  readonly host: string
  readonly builtIn: boolean
  readonly digest?: string
}

export interface CloudflareActorRegistryOptions {
  readonly table?: string
}

const tableOf = (table: string | undefined): string => {
  const selected = table ?? DEFAULT_ACTOR_REGISTRY_TABLE
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(selected)) throw new Error(`actor registry table is not a SQL identifier: ${JSON.stringify(selected)}`)
  return selected
}

const checked = (name: string, encoded: string): CloudflareActorRegistration => {
  const registration = JSON.parse(encoded) as Partial<CloudflareActorRegistration>
  if (
    registration.name !== name ||
    typeof registration.assembly !== "string" ||
    registration.assembly.length === 0 ||
    typeof registration.host !== "string" ||
    registration.host.length === 0 ||
    typeof registration.builtIn !== "boolean"
  ) {
    throw new Error(`actor registry record ${JSON.stringify(name)} is invalid`)
  }
  return registration as CloudflareActorRegistration
}

// CloudflareActorRegistry provides the actor catalog backed by D1.
export class CloudflareActorRegistry extends Context.Service<
  CloudflareActorRegistry,
  ActorRegistry<CloudflareActorRegistration>
>()("tardigrade/cloudflare/ActorRegistry") {}

// layerCloudflareActorRegistry binds the actor registry service to a D1 database.
export const layerCloudflareActorRegistry = (
  database: D1Database,
  options: CloudflareActorRegistryOptions = {}
): Layer.Layer<CloudflareActorRegistry> => {
  const table = tableOf(options.table)
  const make = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${table} (
        name TEXT PRIMARY KEY,
        registration TEXT NOT NULL
      ) WITHOUT ROWID`
    )
    return {
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
      put: (registration: CloudflareActorRegistration) => {
        if (registration.name.length === 0) return Effect.die(new Error("actor registry name must not be empty"))
        return sql.unsafe(
          `INSERT INTO ${table} (name, registration) VALUES (?, ?)
           ON CONFLICT(name) DO UPDATE SET registration = excluded.registration`,
          [registration.name, JSON.stringify(registration)]
        ).pipe(Effect.asVoid, Effect.orDie)
      },
      remove: (name: string) => sql.unsafe(`DELETE FROM ${table} WHERE name = ?`, [name]).pipe(Effect.asVoid, Effect.orDie)
    } satisfies ActorRegistry<CloudflareActorRegistration>
  }).pipe(Effect.orDie)
  return Layer.effect(CloudflareActorRegistry, make).pipe(
    Layer.provide(D1Client.layer({ db: database }).pipe(Layer.orDie))
  )
}
