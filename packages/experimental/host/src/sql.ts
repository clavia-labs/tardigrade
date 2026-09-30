import { Effect, Encoding, ManagedRuntime, Result, type Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { RuntimeError, type Journal, type Recorded, type StoredCheckpoint } from "@clavia/tardigrade-experimental-core"

import { checkpointDigest } from "./services/checkpoint"

// sqlJournal stores event prefixes through an Effect SQL layer; close releases its resources.
export function sqlJournal<Event extends object>(options: {
  readonly actor: string
  readonly layer: Layer.Layer<SqlClient.SqlClient, Error>
  readonly flush?: Effect.Effect<void, Error>
}): Journal<Event> & { readonly close: Effect.Effect<void, Error> } {
  if (!options.actor) throw new RuntimeError("Journal actor identity must be nonempty")
  const runtime = ManagedRuntime.make(options.layer)
  const setup = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS experimental_events (actor TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (actor, seq)) WITHOUT ROWID`
    yield* sql`CREATE TABLE IF NOT EXISTS experimental_checkpoints (actor TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID`
    return sql
  })
  const initialized = Effect.runSync(Effect.cached(runtime.contextEffect.pipe(Effect.flatMap(context => setup.pipe(Effect.provide(context))))))
  let closed = false
  const client = Effect.suspend(() => closed ? Effect.fail(new RuntimeError("Journal is closed")) : initialized)
  const append = (expectedLength: number, events: readonly Recorded<Event>[], checkpoint?: StoredCheckpoint) => Effect.gen(function* () {
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) return yield* Effect.fail(new RuntimeError("Invalid expected journal length"))
    if (checkpoint && (!Number.isSafeInteger(checkpoint.position) || checkpoint.position !== expectedLength + events.length || checkpoint.position < 0)) return yield* Effect.fail(new RuntimeError("Invalid checkpoint position"))
    const encoded = yield* Effect.try({ try: () => events.map(event => JSON.stringify(event)), catch: RuntimeError.from })
    if (checkpoint && checkpoint.digest !== (yield* checkpointDigest(checkpoint.payload))) return yield* Effect.fail(new RuntimeError("Invalid checkpoint digest"))
    const sql = yield* client
    yield* sql.withTransaction(Effect.gen(function* () {
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM experimental_events WHERE actor = ${options.actor}`
      const count = rows[0]?.count
      if (count !== expectedLength) return yield* Effect.fail(new RuntimeError(`Journal conflict for ${options.actor}: expected ${expectedLength}, found ${String(count)}`))
      for (const [index, event] of encoded.entries()) {
        yield* sql`INSERT INTO experimental_events (actor, seq, event) VALUES (${options.actor}, ${expectedLength + index}, ${event})`
      }
      if (checkpoint) {
        const payload = Encoding.encodeBase64(checkpoint.payload)
        yield* sql`INSERT INTO experimental_checkpoints (actor, position, payload, digest) VALUES (${options.actor}, ${checkpoint.position}, ${payload}, ${checkpoint.digest}) ON CONFLICT(actor) DO UPDATE SET position = excluded.position, payload = excluded.payload, digest = excluded.digest`
      }
    }))
    if (options.flush) yield* options.flush
  })
  return {
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
      const rows = yield* sql<{ position: number; payload: string; digest: string }>`SELECT position, payload, digest FROM experimental_checkpoints WHERE actor = ${options.actor}`
      const row = rows[0]
      if (!row) return undefined
      if (!Number.isSafeInteger(row.position) || row.position < 0 || typeof row.payload !== "string" || typeof row.digest !== "string") return yield* Effect.fail(new RuntimeError("Invalid journal checkpoint"))
      const payload = yield* Result.match(Encoding.decodeBase64(row.payload), { onFailure: cause => Effect.fail(RuntimeError.from(cause)), onSuccess: Effect.succeed })
      const actualDigest = yield* checkpointDigest(payload)
      if (actualDigest !== row.digest) return yield* Effect.fail(new RuntimeError("Journal checkpoint digest mismatch"))
      return { position: row.position, payload, digest: row.digest } satisfies StoredCheckpoint
    }),
    appendWithCheckpoint: append,
    close: Effect.sync(() => { closed = true }).pipe(Effect.andThen(runtime.disposeEffect)),
  }
}
