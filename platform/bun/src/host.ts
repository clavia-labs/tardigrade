import { Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import type { Event } from "@tardigrade/core/event"
import { EventLog } from "@tardigrade/core/event-log"
import { Router, type CallResult } from "@tardigrade/core/router"
import { Self, restingActor, settleActor, type Actor } from "@tardigrade/core/actor"
import { deadlocks, victimOf, type EdgesOf } from "@tardigrade/host/deadlock"
import type { HostPorts, LaneEnv } from "@tardigrade/host/host"
import { traceparentOf } from "@tardigrade/core/trace"

// The bun binding: packages/host's semantics with physics. The log lives in SQLite through
// @effect/sql-sqlite-bun, so a process death loses nothing and `recover()` re-derives the owed
// work from what survived; replay is re-derivation, recovery is re-settling
// (packages/core/src/event-log.ts). The store keeps the port's six guarantees: append-only
// rows, one rising seq per lane, this process as the one writer, batch appends in one
// transaction, dedup by key inside that transaction under a unique index, and the ordered tail
// read from a watermark. Conformance is behavioral: host.test.ts mirrors the reference host's
// tests, plus the two only physics can show (a reopen keeps the log; a reopen recovers owed
// work).

type LayersFor<R> = [Exclude<R, HostPorts>] extends [never]
  ? { readonly layersFor?: (lane: string) => LaneEnv<R> }
  : { readonly layersFor: (lane: string) => LaneEnv<R> }

export type BunHostOptions<R> = {
  readonly log: string // where the log lives: a SQLite file, or ":memory:" for a volatile run
  // The tracer the spans flow to, when the app brings one (an @effect/opentelemetry layer, a
  // test capture). Absent, every span is inert: instrumentation lives in the packages, export
  // is the platform's, and this seam is the whole of it.
  readonly telemetry?: Layer.Layer<never>
  readonly principal?: string
  readonly actorFor: (lane: string) => Actor<R> | undefined
  readonly call?: Parameters<typeof Router.of>[0]["call"]
  readonly resume?: Parameters<typeof Router.of>[0]["resume"]
  readonly edgesOf?: EdgesOf
  readonly pick?: (dirty: ReadonlySet<string>) => string
  readonly keyOf?: (e: Event) => string | undefined
} & LayersFor<R>

export interface BunHost {
  readonly seed: (lane: string, events: ReadonlyArray<Event>) => Promise<void>
  readonly read: (lane: string) => Promise<ReadonlyArray<Event>>
  readonly deliver: (address: string, event: Event) => Promise<void>
  readonly wake: (lane: string) => Promise<void>
  readonly drive: () => Promise<void>
  // recover marks every lane that has an actor as owed a visit and drives: the alarm a real
  // process runs at start, so work interrupted by a death settles from the surviving log.
  readonly recover: () => Promise<void>
  readonly resting: () => Promise<boolean>
  readonly self: (lane: string) => string
  readonly close: () => Promise<void>
}

const laneOf = (address: string): string => {
  const i = address.indexOf(":")
  return i === -1 ? address : address.slice(i + 1)
}

const REFUSED: CallResult = { error: "this host takes no synchronous calls" }

export const createBunHost = async <R = never>(options: BunHostOptions<R>): Promise<BunHost> => {
  const principal = options.principal ?? "bun"
  const runtime = ManagedRuntime.make(Layer.mergeAll(SqliteClient.layer({ filename: options.log }), options.telemetry ?? Layer.empty))
  // One client, acquired once: every read and every append shares the connection, so ":memory:"
  // is one database and the per-lane writer stays this process.
  const sql = await runtime.runPromise(SqlClient.SqlClient)
  await runtime.runPromise(
    sql`CREATE TABLE IF NOT EXISTS events (
      lane  TEXT    NOT NULL,
      seq   INTEGER NOT NULL,
      key   TEXT,
      event TEXT    NOT NULL,
      PRIMARY KEY (lane, seq)
    ) WITHOUT ROWID`.pipe(
      Effect.andThen(sql`CREATE UNIQUE INDEX IF NOT EXISTS events_lane_key ON events (lane, key) WHERE key IS NOT NULL`)
    )
  )

  const dirty = new Set<string>()

  const readEffect = (lane: string): Effect.Effect<ReadonlyArray<Event>, never> =>
    sql<{ event: string }>`SELECT event FROM events WHERE lane = ${lane} ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map((row) => JSON.parse(row.event) as Event)),
      Effect.orDie
    )

  // appendEffect keeps guarantees 4 and 5 in the store itself: the batch lands in one
  // transaction, and a keyed event whose key is already recorded is absorbed inside it, leaving
  // MAX(seq) unchanged, which is exactly the honest no-progress answer the settle compares.
  const appendEffect = (lane: string, events: ReadonlyArray<Event>): Effect.Effect<void, never> =>
    events.length === 0
      ? Effect.void
      : sql.withTransaction(
          Effect.gen(function* () {
            const head = yield* sql<{ seq: number }>`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE lane = ${lane}`
            let seq = Number(head[0]?.seq ?? 0) + 1
            for (const e of events) {
              const key = options.keyOf?.(e)
              if (key !== undefined) {
                const present = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM events WHERE lane = ${lane} AND key = ${key}`
                if (Number(present[0]?.n ?? 0) > 0) continue
              }
              yield* sql`INSERT INTO events (lane, seq, key, event) VALUES (${lane}, ${seq}, ${key ?? null}, ${JSON.stringify(e)})`
              seq += 1
            }
          })
        ).pipe(Effect.orDie)

  const headEffect = (lane: string): Effect.Effect<number, never> =>
    sql<{ head: number }>`SELECT COALESCE(MAX(seq), 0) AS head FROM events WHERE lane = ${lane}`.pipe(
      Effect.map((rows) => Number(rows[0]?.head ?? 0)),
      Effect.orDie
    )

  const readFromEffect = (lane: string, mark: number): Effect.Effect<ReadonlyArray<Event>, never> =>
    sql<{ event: string }>`SELECT event FROM events WHERE lane = ${lane} AND seq > ${mark} ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map((row) => JSON.parse(row.event) as Event)),
      Effect.orDie
    )

  const deliverEffect = (address: string, event: Event): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      // The membrane, identical to the reference host: a cross-lane event names its occurrence
      // or it does not travel (packages/host/src/host.ts).
      if (options.keyOf !== undefined && options.keyOf(event) === undefined && event.type !== "MessageReceived") {
        return yield* Effect.die(
          new Error(
            `unkeyed cross-lane event "${event.type}" to ${address}: every delivered event names its occurrence in its package's key fragment`
          )
        )
      }
      const lane = laneOf(address)
      // The platform stamps the sending span's context onto the event it persists (the W3C
      // header form), so a later settle on the receiving lane links back to this delivery: one
      // business event, one trace, across lanes (packages/core/src/trace.ts). An event already
      // carrying a context keeps it: the first stamp is the causal one.
      const current = yield* Effect.currentSpan.pipe(Effect.option)
      const stamped =
        current._tag === "Some" && (event as { traceparent?: unknown }).traceparent === undefined
          ? ({ ...event, traceparent: traceparentOf(current.value) } as Event)
          : event
      if (event.type === "MessageReceived") {
        const id = String((event as { id?: unknown }).id)
        const seen = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM events
          WHERE lane = ${lane} AND json_extract(event, '$.type') = 'MessageReceived' AND json_extract(event, '$.id') = ${id}`.pipe(
          Effect.orDie
        )
        if (Number(seen[0]?.n ?? 0) > 0) return
      }
      yield* appendEffect(lane, [stamped])
      dirty.add(lane)
    }).pipe(Effect.withSpan("deliver", { kind: "producer", attributes: { to: address, type: event.type } }))

  const router = Layer.succeed(Router, {
    deliver: deliverEffect,
    call: options.call ?? (() => Effect.succeed(REFUSED)),
    resume: options.resume ?? (() => Effect.succeed(REFUSED))
  })

  const self = (lane: string): string => `${principal}:${lane}`

  const portsOf = (lane: string) =>
    Layer.mergeAll(
      Layer.succeed(EventLog, {
        append: (events: ReadonlyArray<Event>) => appendEffect(lane, events),
        read: readEffect(lane),
        head: headEffect(lane),
        readFrom: (mark: number) => readFromEffect(lane, mark)
      }),
      router,
      Layer.succeed(Self, self(lane))
    )

  const layersOf = (lane: string): Layer.Layer<R | EventLog> => {
    const extra = (options.layersFor ?? (() => Layer.empty as unknown as LaneEnv<R>))(lane)
    return extra.pipe(Layer.provideMerge(portsOf(lane))) as Layer.Layer<R | EventLog>
  }

  const drain = async (): Promise<void> => {
    while (dirty.size > 0) {
      const lane = options.pick?.(dirty) ?? (dirty.values().next().value as string)
      dirty.delete(lane)
      const actor = options.actorFor(lane)
      if (actor === undefined) continue
      await runtime.runPromise(settleActor(actor).pipe(Effect.provide(layersOf(lane))))
    }
  }

  const lanesMap = async (): Promise<Map<string, ReadonlyArray<Event>>> => {
    const rows = await runtime.runPromise(sql<{ lane: string }>`SELECT DISTINCT lane FROM events`.pipe(Effect.orDie))
    const map = new Map<string, ReadonlyArray<Event>>()
    for (const row of rows) map.set(row.lane, await runtime.runPromise(readEffect(row.lane)))
    return map
  }

  const drive = async (): Promise<void> => {
    await drain()
    if (options.edgesOf === undefined) return
    for (;;) {
      const found = deadlocks(await lanesMap(), options.edgesOf)
      if (found.length === 0) return
      for (const knot of found) {
        const victim = victimOf(knot)
        await runtime.runPromise(
          deliverEffect(victim.from, {
            type: "MessageReceived",
            id: victim.replyId,
            outcome: "failed",
            text: `deadlock: ${[...knot.members, knot.members[0]].join(" waits for ")}`,
            at: 0
          } as Event)
        )
      }
      await drain()
    }
  }

  const resting = async (): Promise<boolean> => {
    for (const [lane, events] of await lanesMap()) {
      const actor = options.actorFor(lane)
      if (actor !== undefined && !restingActor(actor, events)) return false
    }
    return dirty.size === 0
  }

  const recover = async (): Promise<void> => {
    for (const lane of (await lanesMap()).keys()) {
      if (options.actorFor(lane) !== undefined) dirty.add(lane)
    }
    await drive()
  }

  return {
    seed: (lane, events) => runtime.runPromise(appendEffect(lane, events)),
    read: (lane) => runtime.runPromise(readEffect(lane)),
    deliver: (address, event) => runtime.runPromise(deliverEffect(address, event)),
    wake: (lane) => {
      dirty.add(lane)
      return drive()
    },
    drive,
    recover,
    resting,
    self,
    close: () => runtime.dispose()
  }
}
