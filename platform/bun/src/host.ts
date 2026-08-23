import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { KeyValueStore } from "effect/unstable/persistence"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog } from "@clavia/tardigrade-core/event-log"
import { assertSupportedBun } from "@clavia/tardigrade-core/runtime"
import { Router, deliverThrough, transportRoute, type CallResult } from "@clavia/tardigrade-core/communication/router"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"
import { linkedEventOf, type Delivery } from "@clavia/tardigrade-core/communication/delivery"
import {
  formatActorAddress,
  isActorAddress,
  isProviderAddress,
  parseActorAddress,
  type ActorAddress,
  type ProviderAddress
} from "@clavia/tardigrade-core/communication/address"
import type { Link } from "@clavia/tardigrade-core/communication/link"
import { Self, restingActor, settleActor, type Actor } from "@clavia/tardigrade-core/actor"
import { Facets } from "@clavia/tardigrade-core/facets"
import { deadlocks, victimOf, type EdgesOf } from "@clavia/tardigrade-host/deadlock"
import type { HostPorts } from "@clavia/tardigrade-host/host"
import { outboundFrom, type Provider } from "@clavia/tardigrade-host/communication/provider"
import { traceparentOf } from "@clavia/tardigrade-core/trace"
import {
  sameActorAddress,
  sameThreadLineage,
  threadCreated,
  threadCreatedOf,
  threadKeys,
  type ThreadLineage
} from "@clavia/tardigrade-core/thread"
import { bunWorkspace, bunWorkspaceSql, workspaceSqlFile } from "./workspace"

// The bun binding: packages/host's semantics with physics. The log lives in SQLite through
// @effect/sql-sqlite-bun, so a process death loses nothing and `recover()` re-derives the owed
// work from what survived; replay is re-derivation, recovery is re-settling
// (packages/core/src/event-log.ts). The store keeps the port's six guarantees: append-only
// rows, one rising seq per lane, this process as the one writer, batch appends in one
// transaction, dedup by key inside that transaction under a unique index, and the ordered tail
// read from a watermark. Conformance is behavioral: host.test.ts mirrors the reference host's
// tests, plus the two only physics can show (a reopen keeps the log; a reopen recovers owed
// work). The same database holds the workspace a bounded value spills to; the tables the model
// creates through workspace.sql live in a second file beside it, out of the log's reach
// (workspace.ts).

// BunPorts are the services this binding leaves an actor no work to bind: packages/host's four,
// plus the workspace store, which on bun is durable and therefore the platform's to give
// (packages/code/src/store.ts). BunLaneEnv is the rest of an actor's R, the same shape the
// reference host asks for.
type BunPorts = HostPorts | KeyValueStore.KeyValueStore
type BunLaneEnv<R> = Layer.Layer<Exclude<R, BunPorts>, never, BunPorts>

type LayersFor<R> = [Exclude<R, BunPorts>] extends [never]
  ? { readonly layersFor?: (lane: string) => BunLaneEnv<R> }
  : { readonly layersFor: (lane: string) => BunLaneEnv<R> }

export type BunHostOptions<R> = {
  readonly log: string // where the log lives: a SQLite file, or ":memory:" for a volatile run
  // The tracer the spans flow to, when the app brings one (an @effect/opentelemetry layer, a
  // test capture). Absent, every span is inert: instrumentation lives in the packages, export
  // is the platform's, and this seam is the whole of it.
  readonly telemetry?: Layer.Layer<never>
  // The store spilled values land in. The default is `bunWorkspace()`, durable in the log's own
  // database; an app that wants another table, a prefixed view, or a volatile run passes its own
  // layer over the same client (workspace.ts).
  readonly workspace?: Layer.Layer<KeyValueStore.KeyValueStore, never, SqlClient.SqlClient>
  // The SQL surface the workspace's sql verb runs on. The default is `bunWorkspaceSql()` over a
  // database beside the log, so the model's own tables are durable and the log is out of its reach
  // (workspace.ts). `false` withholds the surface and the workspace package drops the method, which
  // is the honest answer for an agent that should never run SQL; any other layer replaces it, and
  // one built over the host's own client hands the model the log's database too, which is what
  // `bunWorkspaceSql({ doc: bunWorkspaceLogSqlDoc() })` tells the model it is holding.
  readonly workspaceSql?: false | Layer.Layer<never, never, SqlClient.SqlClient>
  readonly principal?: string
  readonly actorFor: (lane: string) => Actor<R> | undefined
  readonly call?: Parameters<typeof Router.of>[0]["call"]
  readonly resume?: Parameters<typeof Router.of>[0]["resume"]
  readonly providers?: ReadonlyArray<Provider>
  readonly edgesOf?: EdgesOf
  readonly pick?: (dirty: ReadonlySet<string>) => string
  readonly keyOf?: (e: Event) => string | undefined
} & LayersFor<R>

export interface BunHost {
  readonly seed: (lane: string, events: ReadonlyArray<Event>) => Promise<void>
  readonly read: (lane: string) => Promise<ReadonlyArray<Event>>
  readonly accept: (delivery: Delivery<unknown, Event, ActorAddress>) => Promise<void>
  // lanes names every lane the log holds, ordered by name. An app that lists what exists asks the
  // host rather than the database, so the store stays this module's (host.test.ts, "lanes names
  // every lane the log holds").
  readonly lanes: () => Promise<ReadonlyArray<string>>
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
  assertSupportedBun()
  if (options.log !== "" && options.log !== ":memory:") await mkdir(dirname(options.log), { recursive: true })
  const principal = options.principal ?? "bun"
  // The workspace is built with the runtime and over the same client, so its table is created once
  // and every lane spills through the connection the log already holds.
  const client = SqliteClient.layer({ filename: options.log })
  // The SQL surface holds its own client on its own file, so a statement the model wrote reaches
  // its tables and nothing else (workspace.ts). Both clients are built with the runtime and closed
  // with it.
  const workspaceSql =
    options.workspaceSql === false
      ? Layer.empty
      : options.workspaceSql === undefined
        ? bunWorkspaceSql().pipe(Layer.provide(SqliteClient.layer({ filename: workspaceSqlFile(options.log) })))
        : options.workspaceSql.pipe(Layer.provide(client))
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      (options.workspace ?? bunWorkspace()).pipe(Layer.provideMerge(client)),
      workspaceSql,
      options.telemetry ?? Layer.empty
    )
  )
  // One client, acquired once: every read and every append shares the connection, so ":memory:"
  // is one database and the per-lane writer stays this process.
  const sql = await runtime.runPromise(SqlClient.SqlClient)
  // The store, acquired the same way: one instance, one table build, handed to every lane below.
  const store = await runtime.runPromise(KeyValueStore.KeyValueStore)
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
  const outbound = outboundFrom(options.providers ?? [])
  const storeKeyOf = (event: Event): string | undefined => threadKeys.keyOf(event) ?? options.keyOf?.(event)

  const readEffect = (lane: string): Effect.Effect<ReadonlyArray<Event>, never> =>
    sql<{ event: string }>`SELECT event FROM events WHERE lane = ${lane} ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map((row) => JSON.parse(row.event) as Event)),
      Effect.orDie
    )

  const appendRowsEffect = (lane: string, events: ReadonlyArray<Event>): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const head = yield* sql<{ seq: number }>`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE lane = ${lane}`
      let seq = Number(head[0]?.seq ?? 0) + 1
      for (const event of events) {
        const key = storeKeyOf(event)
        if (key !== undefined) {
          const present = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM events WHERE lane = ${lane} AND key = ${key}`
          if (Number(present[0]?.n ?? 0) > 0) continue
        }
        yield* sql`INSERT INTO events (lane, seq, key, event) VALUES (${lane}, ${seq}, ${key ?? null}, ${JSON.stringify(event)})`
        seq += 1
      }
    }).pipe(Effect.orDie)

  // appendEffect keeps guarantees 4 and 5 in the store itself: the batch lands in one transaction, and a keyed event already recorded is absorbed inside it.
  const appendEffect = (lane: string, events: ReadonlyArray<Event>): Effect.Effect<void, never> =>
    events.length === 0 ? Effect.void : sql.withTransaction(appendRowsEffect(lane, events)).pipe(Effect.orDie)

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

  const commitEffect = (
    target: ActorAddress,
    event: Event,
    lineage: ThreadLineage | undefined,
    link?: Link<unknown, ActorAddress>
  ): Effect.Effect<void, never> => {
    const address = formatActorAddress(target)
    return Effect.gen(function* () {
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
      const appended = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ event: string }>`SELECT event FROM events WHERE lane = ${lane} ORDER BY seq`
          const events = rows.map((row) => JSON.parse(row.event) as Event)
          const created = threadCreatedOf(events)
          if (events.length > 0 && created === undefined) {
            return yield* Effect.die(new Error(`thread ${address} has no ThreadCreated first event`))
          }
          if (created !== undefined && !sameActorAddress(created.address, target)) {
            return yield* Effect.die(new Error(`thread ${address} creation address does not match its target`))
          }
          if (lineage !== undefined) {
            if (lineage.depth <= 0 || sameActorAddress(lineage.parent, target)) {
              return yield* Effect.die(new Error(`thread ${address} has invalid child lineage`))
            }
            if (link === undefined || !isActorAddress(link.source) || !sameActorAddress(lineage.parent, link.source)) {
              return yield* Effect.die(new Error(`thread ${address} lineage parent does not match its delivery source`))
            }
            if (created !== undefined && !sameThreadLineage(created, lineage)) {
              return yield* Effect.die(new Error(`thread ${address} already has different lineage`))
            }
          } else if (created === undefined && link !== undefined && isActorAddress(link.source)) {
            return yield* Effect.die(new Error(`initial actor delivery to ${address} must carry lineage`))
          }
          const landed = link !== undefined && stamped.type === "MessageReceived"
            ? linkedEventOf({ link, event: stamped })
            : stamped
          if (landed.type === "MessageReceived") {
            const id = String((landed as { id?: unknown }).id)
            if (events.some((candidate) => candidate.type === "MessageReceived" && String((candidate as { id?: unknown }).id) === id)) {
              return false
            }
          }
          const at = (event as { readonly at?: unknown }).at
          if (created === undefined && (typeof at !== "number" || !Number.isFinite(at))) {
            return yield* Effect.die(new Error(`first thread event "${event.type}" must carry a finite at`))
          }
          yield* appendRowsEffect(
            lane,
            created === undefined ? [threadCreated(target, lineage, at as number), landed] : [landed]
          )
          return true
        })
      ).pipe(Effect.orDie)
      if (appended) dirty.add(lane)
    }).pipe(Effect.withSpan("deliver", { kind: "producer", attributes: { to: address, type: event.type } }))
  }

  const acceptEffect = (delivery: Delivery<unknown, Event, ActorAddress>): Effect.Effect<void, never> =>
    commitEffect(delivery.link.target, delivery.event, delivery.lineage, delivery.link)

  const deliverEffect = (address: string, event: Event): Effect.Effect<void, never> =>
    commitEffect(parseActorAddress(address), event, undefined)

  const localTransport: Transport<ActorAddress> = {
    name: "local",
    deliver: (coordinates, delivery) => acceptEffect({
      ...delivery,
      link: { source: delivery.link.source, target: coordinates }
    })
  }
  const providerTransport: Transport<ProviderAddress> = {
    name: "provider",
    deliver: (coordinates, delivery) => outbound.send(
      { source: delivery.link.source, target: coordinates },
      delivery.event as import("@clavia/tardigrade-core/communication/message").MessageReceived
    )
  }
  const routes = [
    transportRoute(localTransport, (delivery) => isActorAddress(delivery.link.target) ? delivery.link.target : undefined),
    transportRoute(providerTransport, (delivery) => isProviderAddress(delivery.link.target) ? delivery.link.target : undefined)
  ]
  const router = Layer.succeed(Router, {
    deliver: (delivery) => deliverThrough(routes, delivery),
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
      Layer.succeed(KeyValueStore.KeyValueStore, store),
      Layer.succeed(Self, parseActorAddress(self(lane))),
      // Every lane's log lives in this one durable store, so the observe privilege is the same
      // read the host serves itself (packages/core/src/facets.ts, Facets). A binding whose lanes
      // are remote proxies or refuses instead.
      Layer.succeed(Facets, { read: (name: string) => readEffect(name) })
    )

  const layersOf = (lane: string): Layer.Layer<R | EventLog> => {
    const extra = (options.layersFor ?? (() => Layer.empty as unknown as BunLaneEnv<R>))(lane)
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

  const lanesEffect: Effect.Effect<ReadonlyArray<string>, never> = sql<{
    lane: string
  }>`SELECT DISTINCT lane FROM events ORDER BY lane`.pipe(
    Effect.map((rows) => rows.map((row) => row.lane)),
    Effect.orDie
  )

  const lanesMap = async (): Promise<Map<string, ReadonlyArray<Event>>> => {
    const lanes = await runtime.runPromise(lanesEffect)
    const map = new Map<string, ReadonlyArray<Event>>()
    for (const lane of lanes) map.set(lane, await runtime.runPromise(readEffect(lane)))
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
          deliverEffect(self(victim.from), {
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
    accept: (delivery) => runtime.runPromise(acceptEffect(delivery)),
    lanes: () => runtime.runPromise(lanesEffect),
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
