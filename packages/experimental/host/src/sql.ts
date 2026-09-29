import { Effect, ManagedRuntime, type Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { RuntimeError, type Journal, type Recorded } from "@clavia/tardigrade-experimental-core"

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
    return sql
  })
  const initialized = Effect.runSync(Effect.cached(runtime.contextEffect.pipe(Effect.flatMap(context => setup.pipe(Effect.provide(context))))))
  let closed = false
  const client = Effect.suspend(() => closed ? Effect.fail(new RuntimeError("Journal is closed")) : initialized)
  return {
    read: Effect.gen(function* () {
      const sql = yield* client
      const rows = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${options.actor} ORDER BY seq`
      return yield* Effect.try({ try: () => rows.map((row, index) => {
        if (row.seq !== index || typeof row.event !== "string") throw new RuntimeError("Invalid journal sequence")
        return JSON.parse(row.event) as Recorded<Event>
      }), catch: RuntimeError.from })
    }),
    append: (expectedLength, events) => Effect.gen(function* () {
      if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) return yield* Effect.fail(new RuntimeError("Invalid expected journal length"))
      const encoded = yield* Effect.try({ try: () => events.map(event => JSON.stringify(event)), catch: RuntimeError.from })
      const sql = yield* client
      yield* sql.withTransaction(Effect.gen(function*() {
        const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM experimental_events WHERE actor = ${options.actor}`
        const count = rows[0]?.count
        if (count !== expectedLength) return yield* Effect.fail(new RuntimeError(`Journal conflict for ${options.actor}: expected ${expectedLength}, found ${String(count)}`))
        for (const [index, event] of encoded.entries()) {
          yield* sql`INSERT INTO experimental_events (actor, seq, event) VALUES (${options.actor}, ${expectedLength + index}, ${event})`
        }
      }))
      if (options.flush) yield* options.flush
    }),
    close: Effect.sync(() => { closed = true }).pipe(Effect.andThen(runtime.disposeEffect)),
  }
}
