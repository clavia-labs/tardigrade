import { Effect, Layer, ManagedRuntime, PubSub, Stream } from "effect"
import { mkdir, readdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { KeyValueStore } from "effect/unstable/persistence"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, eventLogFrom, type AppendResult, type ThreadEventRow, type ThreadEventStore } from "@clavia/tardigrade-core/log"
import { mappedDirectory } from "@clavia/tardigrade-core/communication/directory"
import { Router, directoryRoute, sendThrough, type TransportRoute } from "@clavia/tardigrade-core/communication/router"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"
import { isActorEnvelope, isProviderEnvelope, linkedEventOf, type ActorEnvelope, type Envelope } from "@clavia/tardigrade-core/communication/envelope"
import { formatThreadAddress, parseThreadAddress, type ThreadAddress, type ProviderEndpoint } from "@clavia/tardigrade-core/communication/endpoint"
import type { Link } from "@clavia/tardigrade-core/communication/link"
import {
  actorEventKeyOf,
  type ActorThreadCreated,
  type ThreadRequested
} from "@clavia/tardigrade-core/actor"
import {
  alarmFired,
  earliestDeadlineOf,
  methodIngressKeyOf,
  type ActorInvocationContext,
  type ActorMethods
} from "@clavia/tardigrade-core/actor/method"
import {
  EffectInterruptions,
  Self,
  effectInterruptionRegistry,
  restingActor,
  settleActor,
  type Actor
} from "@clavia/tardigrade-core/reconciliation"
import { threadCreated, threadCreatedForDelivery, threadCreatedOf, threadKeys, type ThreadLineage, type ChildPlacement } from "@clavia/tardigrade-core/thread"
import { deadlocks, victimOf, type EdgesOf } from "@clavia/tardigrade-host/deadlock"
import type { HostPorts } from "@clavia/tardigrade-host/host"
import { providerTransportFrom, type Provider } from "@clavia/tardigrade-host/communication/provider"
import { createThreadDriver, type DriverPolicy } from "@clavia/tardigrade-host/driver"
import { CommitDispatcher, type CommitObserver } from "@clavia/tardigrade-host/commit"
import { traceparentOf } from "@clavia/tardigrade-core/log/trace"
import { assertSupportedBun } from "./runtime"
import { bunWorkspace, bunWorkspaceSql, workspaceSqlFile } from "./workspace"
import { bunSandboxFor, type BunSandboxPolicy } from "./sandbox"
import { bunAlarmScheduler, type BunAlarmHandle, type BunAlarmScheduler } from "./alarm"

type BunPorts = HostPorts | KeyValueStore.KeyValueStore
type BunThreadServices = BunPorts | SqlClient.SqlClient
type BunThreadEnv<R> = Layer.Layer<Exclude<R, BunPorts>, never, BunPorts>
type LayersFor<R> = [Exclude<R, BunPorts>] extends [never]
  ? { readonly layersFor?: (thread: string) => BunThreadEnv<R> }
  : { readonly layersFor: (thread: string) => BunThreadEnv<R> }

// bunThreadDatabasePath places a thread database beside the actor directory database. The reversible encoding lets startup repair the directory from surviving files.
export const bunThreadDatabasePath = (actorDatabase: string, thread: string): string =>
  actorDatabase === ":memory:" ? ":memory:" : join(`${actorDatabase}.threads`, `${Buffer.from(thread, "utf8").toString("base64url")}.sqlite`)

export const BUN_CHILD_PLACEMENTS = ["colocated"] as const satisfies ReadonlyArray<ChildPlacement>
export const DEFAULT_BUN_CHILD_PLACEMENT: ChildPlacement = "colocated"

export type BunHostOptions<R> = {
  // database stores the actor identity and event log. Each thread database lives at threadDatabase(thread).
  readonly database: string
  // threadDatabase selects the physical database for a thread. The default is bunThreadDatabasePath(database, thread).
  readonly threadDatabase?: (thread: string) => string
  readonly defaultChildPlacement?: ChildPlacement
  readonly telemetry?: Layer.Layer<never>
  readonly workspace?: Layer.Layer<KeyValueStore.KeyValueStore, never, SqlClient.SqlClient>
  readonly workspaceSql?: false | Layer.Layer<never, never, SqlClient.SqlClient>
  readonly sandbox?: Partial<BunSandboxPolicy>
  readonly actorName?: string
  readonly actorInstance?: string
  readonly actorFor: (thread: string) => Actor<R> | undefined
  readonly providers?: ReadonlyArray<Provider>
  readonly routes?: ReadonlyArray<TransportRoute>
  readonly edgesOf?: EdgesOf
  readonly driver?: Partial<DriverPolicy>
  readonly alarm?: BunAlarmScheduler
  readonly pick?: (dirty: ReadonlySet<string>) => string
  readonly keyOf?: (event: Event) => string | undefined
  readonly commitObserverFor?: (context: { readonly actorInstance: string; readonly thread: string }) => CommitObserver
} & LayersFor<R>

export interface BunHost {
  readonly seed: (thread: string, events: ReadonlyArray<Event>) => Promise<void>
  readonly read: (thread: string) => Promise<ReadonlyArray<Event>>
  readonly readPage: (thread: string, mark: number, limit: number) => Promise<ReadonlyArray<ThreadEventRow>>
  readonly awaitHead: (thread: string, mark: number, signal?: AbortSignal) => Promise<number>
  readonly readActorPage: (mark: number, limit: number) => Promise<ReadonlyArray<ThreadEventRow>>
  readonly actorHead: () => Promise<number>
  readonly awaitActorHead: (mark: number, signal?: AbortSignal) => Promise<number>
  readonly commit: (envelope: Envelope<unknown, Event, ThreadAddress>) => Promise<void>
  readonly threads: () => Promise<ReadonlyArray<string>>
  readonly commitRoot: (address: string, event: Event) => Promise<void>
  readonly wake: (thread: string) => Promise<void>
  readonly drive: () => Promise<void>
  readonly recover: () => Promise<void>
  readonly resting: () => Promise<boolean>
  readonly work: () => number
  readonly self: (thread: string) => string
  readonly close: () => Promise<void>
}

interface BunThreadRuntime {
  readonly runtime: ManagedRuntime.ManagedRuntime<BunThreadServices, never>
  readonly store: ThreadEventStore
  readonly commits: PubSub.PubSub<number>
  readonly commitDispatcher?: CommitDispatcher
  readonly workspace: KeyValueStore.KeyValueStore
  readonly interruptions: ReturnType<typeof effectInterruptionRegistry>
  alarm?: { readonly deadlineAt: number; readonly handle: BunAlarmHandle }
}

const threadOf = (address: string): string => {
  return parseThreadAddress(address).thread
}

const threadFromDatabase = (file: string): string | undefined => {
  if (!file.endsWith(".sqlite")) return undefined
  try {
    const encoded = file.slice(0, -7)
    const thread = Buffer.from(encoded, "base64url").toString("utf8")
    return Buffer.from(thread, "utf8").toString("base64url") === encoded ? thread : undefined
  } catch {
    return undefined
  }
}

const actorMigrations = SqliteMigrator.fromRecord({
  "0001_actor_identity": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE actor_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      actor TEXT NOT NULL,
      instance TEXT NOT NULL
    )`
  }),
  "0002_actor_directory": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE thread_directory (
      thread TEXT PRIMARY KEY,
      parent_thread TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      placement TEXT
    ) WITHOUT ROWID`
  }),
  "0003_actor_events": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE actor_events (
      seq INTEGER NOT NULL PRIMARY KEY,
      key TEXT,
      event TEXT NOT NULL
    ) WITHOUT ROWID`
    yield* sql`CREATE UNIQUE INDEX actor_events_key ON actor_events (key) WHERE key IS NOT NULL`
  })
})

const threadMigrations = SqliteMigrator.fromRecord({
  "0001_thread_identity": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE thread_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      actor TEXT NOT NULL,
      instance TEXT NOT NULL,
      thread TEXT NOT NULL
    )`
  }),
  "0002_thread_events": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE events (
      seq INTEGER NOT NULL PRIMARY KEY,
      key TEXT,
      event TEXT NOT NULL
    ) WITHOUT ROWID`
    yield* sql`CREATE UNIQUE INDEX events_key ON events (key) WHERE key IS NOT NULL`
  })
})

const initializeDatabase = (loader: SqliteMigrator.Loader): Effect.Effect<void, never, SqlClient.SqlClient> =>
  SqliteMigrator.run({ loader }).pipe(Effect.asVoid, Effect.orDie)

// openActorDirectory initializes one actor database and recovers directory entries from its thread files.
const openActorDirectory = async (
  options: Pick<BunHostOptions<never>, "database" | "threadDatabase" | "telemetry">,
  actorName: string,
  actorInstance: string
) => {
  if (options.database !== "" && options.database !== ":memory:") await mkdir(dirname(options.database), { recursive: true })
  const runtime = ManagedRuntime.make(Layer.mergeAll(SqliteClient.layer({ filename: options.database }), options.telemetry ?? Layer.empty))
  const sql = await runtime.runPromise(SqlClient.SqlClient)
  try {
    await runtime.runPromise(initializeDatabase(actorMigrations))
    await runtime.runPromise(sql`
      INSERT OR IGNORE INTO actor_identity (singleton, actor, instance) VALUES (1, ${actorName}, ${actorInstance})
    `.pipe(Effect.orDie))
    const identities = await runtime.runPromise(sql<{ actor: string; instance: string }>`
      SELECT actor, instance FROM actor_identity WHERE singleton = 1
    `.pipe(Effect.orDie))
    if (identities[0]?.actor !== actorName || identities[0]?.instance !== actorInstance) {
      throw new Error("actor identity does not match its database")
    }
    if (options.database !== ":memory:" && options.threadDatabase === undefined) {
      const directory = `${options.database}.threads`
      await mkdir(directory, { recursive: true })
      for (const file of await readdir(directory)) {
        const thread = threadFromDatabase(basename(file))
        if (thread !== undefined) await runtime.runPromise(sql`INSERT OR IGNORE INTO thread_directory (thread) VALUES (${thread})`.pipe(Effect.orDie))
      }
    }
    return { runtime, sql }
  } catch (cause) {
    await runtime.dispose()
    throw cause
  }
}

// createBunHost runs an actor definition over isolated thread databases in one Bun process.
export const createBunHost = async <R = never>(options: BunHostOptions<R>): Promise<BunHost> => {
  assertSupportedBun()
  const actorName = options.actorName ?? "bun"
  const actorInstance = options.actorInstance ?? "default"
  const defaultChildPlacement = options.defaultChildPlacement ?? DEFAULT_BUN_CHILD_PLACEMENT
  if (!BUN_CHILD_PLACEMENTS.includes(defaultChildPlacement as "colocated")) {
    throw new Error(`Bun host does not support ${JSON.stringify(defaultChildPlacement)} thread placement`)
  }
  const pathOf = options.threadDatabase ?? ((thread: string) => bunThreadDatabasePath(options.database, thread))
  const { runtime: directoryRuntime, sql: directorySql } = await openActorDirectory(options, actorName, actorInstance)
  const actorCommits = await directoryRuntime.runPromise(PubSub.sliding<number>({ capacity: 1, replay: 1 }))
  const actorHead = async (): Promise<number> => {
    const rows = await directoryRuntime.runPromise(directorySql<{ head: number }>`SELECT COALESCE(MAX(seq), 0) AS head FROM actor_events`.pipe(Effect.orDie))
    return Number(rows[0]?.head ?? 0)
  }
  const readActorPage = (mark: number, limit: number): Promise<ReadonlyArray<ThreadEventRow>> =>
    directoryRuntime.runPromise(directorySql<{ seq: number; event: string }>`
      SELECT seq, event FROM actor_events WHERE seq > ${mark} ORDER BY seq LIMIT ${limit}
    `.pipe(
      Effect.map((rows) => rows.map((row) => ({ seq: Number(row.seq), event: JSON.parse(row.event) as Event }))),
      Effect.orDie
    ))
  await directoryRuntime.runPromise(PubSub.publish(actorCommits, await actorHead()))
  const appendActorEvent = async (event: Event): Promise<void> => {
    const head = await directoryRuntime.runPromise(directorySql.withTransaction(Effect.gen(function*() {
      const rows = yield* directorySql<{ head: number }>`SELECT COALESCE(MAX(seq), 0) AS head FROM actor_events`
      const current = Number(rows[0]?.head ?? 0)
      const key = actorEventKeyOf(event)
      if (key !== undefined) {
        const present = yield* directorySql<{ present: number }>`SELECT 1 AS present FROM actor_events WHERE key = ${key}`
        if (present.length > 0) return current
      }
      const next = current + 1
      yield* directorySql`INSERT INTO actor_events (seq, key, event) VALUES (${next}, ${key ?? null}, ${JSON.stringify(event)})`
      return next
    }).pipe(Effect.orDie)))
    await directoryRuntime.runPromise(PubSub.publish(actorCommits, head))
  }
  const register = async (thread: string, lineage?: ThreadLineage, at = Date.now()): Promise<void> => {
    if (lineage !== undefined && (
      lineage.parent.actor !== actorName || lineage.parent.instance !== actorInstance
    )) {
      throw new Error("a child thread must inherit its actor instance")
    }
    await directoryRuntime.runPromise(lineage === undefined
      ? directorySql`INSERT OR IGNORE INTO thread_directory (thread) VALUES (${thread})`.pipe(Effect.asVoid, Effect.orDie)
      : directorySql`INSERT INTO thread_directory (thread, parent_thread, depth, placement)
          VALUES (${thread}, ${lineage.parent.thread}, ${lineage.depth}, ${lineage.placement ?? null})
          ON CONFLICT(thread) DO UPDATE SET
            parent_thread = excluded.parent_thread,
            depth = excluded.depth,
            placement = excluded.placement`.pipe(Effect.asVoid, Effect.orDie)
    )
    await appendActorEvent({
      type: "ThreadRequested",
      thread,
      ...(lineage === undefined ? { depth: 0 } : {
        parentThread: lineage.parent.thread,
        depth: lineage.depth,
        ...(lineage.placement === undefined ? {} : { placement: lineage.placement })
      }),
      at
    } satisfies ThreadRequested)
    await appendActorEvent({ type: "ThreadCreated", thread, at } satisfies ActorThreadCreated)
  }
  const threads = (): Promise<ReadonlyArray<string>> => directoryRuntime.runPromise(
    directorySql<{ thread: string }>`SELECT thread FROM thread_directory ORDER BY thread`.pipe(Effect.map((rows) => rows.map((row) => row.thread)), Effect.orDie)
  )
  const storeKeyOf = (event: Event): string | undefined =>
    methodIngressKeyOf(event) ?? threadKeys.keyOf(event) ?? options.keyOf?.(event)
  const runtimes = new Map<string, Promise<BunThreadRuntime>>()

  const openThread = async (thread: string): Promise<BunThreadRuntime> => {
    const filename = pathOf(thread)
    if (filename !== "" && filename !== ":memory:") await mkdir(dirname(filename), { recursive: true })
    const client = SqliteClient.layer({ filename })
    const workspaceSql = options.workspaceSql === false
      ? Layer.empty
      : options.workspaceSql === undefined
        ? bunWorkspaceSql().pipe(Layer.provide(SqliteClient.layer({ filename: workspaceSqlFile(filename) })))
        : options.workspaceSql.pipe(Layer.provide(client))
    const runtime = ManagedRuntime.make(Layer.mergeAll(
      (options.workspace ?? bunWorkspace()).pipe(Layer.provideMerge(client)),
      workspaceSql,
      options.telemetry ?? Layer.empty
    )) as ManagedRuntime.ManagedRuntime<BunThreadServices, never>
    let sql: SqlClient.SqlClient
    let workspace: KeyValueStore.KeyValueStore
    try {
      sql = await runtime.runPromise(SqlClient.SqlClient)
      await runtime.runPromise(initializeDatabase(threadMigrations))
      await runtime.runPromise(sql`
        INSERT OR IGNORE INTO thread_identity (singleton, actor, instance, thread)
        VALUES (1, ${actorName}, ${actorInstance}, ${thread})
      `.pipe(Effect.orDie))
      const identities = await runtime.runPromise(sql<{ actor: string; instance: string; thread: string }>`
        SELECT actor, instance, thread FROM thread_identity WHERE singleton = 1
      `.pipe(Effect.orDie))
      if (
        identities[0]?.actor !== actorName ||
        identities[0]?.instance !== actorInstance ||
        identities[0]?.thread !== thread
      ) throw new Error("thread identity does not match its database")
      workspace = await runtime.runPromise(KeyValueStore.KeyValueStore)
    } catch (cause) {
      await runtime.dispose()
      throw cause
    }
    const read: ThreadEventStore["read"] = sql<{ event: string }>`SELECT event FROM events ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map((row) => JSON.parse(row.event) as Event)), Effect.orDie
    )
    const head: ThreadEventStore["head"] = sql<{ head: number }>`SELECT COALESCE(MAX(seq), 0) AS head FROM events`.pipe(
      Effect.map((rows) => Number(rows[0]?.head ?? 0)), Effect.orDie
    )
    const readFrom: ThreadEventStore["readFrom"] = (mark) => sql<{ event: string }>`SELECT event FROM events WHERE seq > ${mark} ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map((row) => JSON.parse(row.event) as Event)), Effect.orDie
    )
    const readPage: ThreadEventStore["readPage"] = (mark, limit) => sql<{ seq: number; event: string }>`
      SELECT seq, event FROM events WHERE seq > ${mark} ORDER BY seq LIMIT ${limit}
    `.pipe(
      Effect.map((rows) => rows.map((row) => ({ seq: Number(row.seq), event: JSON.parse(row.event) as Event }))),
      Effect.orDie
    )
    const commits = await runtime.runPromise(PubSub.sliding<number>({ capacity: 1, replay: 1 }))
    const interruptions = effectInterruptionRegistry()
    const observer = options.commitObserverFor?.({ actorInstance, thread })
    const commitDispatcher = observer === undefined ? undefined : new CommitDispatcher(observer)
    {
      const currentHead = await runtime.runPromise(head)
      await runtime.runPromise(PubSub.publish(commits, currentHead))
    }
    const append: ThreadEventStore["append"] = (events) => {
      if (events.length === 0) return Effect.map(head, (current) => ({ appended: 0, head: current }))
      return sql.withTransaction(Effect.gen(function* () {
        const rows = yield* sql<{ seq: number }>`SELECT COALESCE(MAX(seq), 0) AS seq FROM events`
        const currentHead = Number(rows[0]?.seq ?? 0)
        let seq = currentHead + 1
        let appended = 0
        for (const event of events) {
          const key = storeKeyOf(event)
          if (key !== undefined) {
            const present = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM events WHERE key = ${key}`
            if (Number(present[0]?.n ?? 0) > 0) continue
          }
          yield* sql`INSERT INTO events (seq, key, event) VALUES (${seq}, ${key ?? null}, ${JSON.stringify(event)})`
          seq += 1
          appended += 1
        }
        return { appended, head: seq - 1 }
      })).pipe(
        Effect.tap((result) => result.appended > 0
          ? Effect.all([
              PubSub.publish(commits, result.head),
              Effect.sync(() => commitDispatcher?.offer({ actor: actorName, instance: actorInstance, thread, head: result.head }))
            ]).pipe(Effect.asVoid)
          : Effect.void),
        Effect.orDie
      )
    }
    return {
      runtime,
      store: { append, read, head, readFrom, readPage },
      commits,
      interruptions,
      ...(commitDispatcher === undefined ? {} : { commitDispatcher }),
      workspace
    }
  }

  const runtimeOf = (thread: string): Promise<BunThreadRuntime> => {
    const current = runtimes.get(thread)
    if (current !== undefined) return current
    const opened = openThread(thread)
    runtimes.set(thread, opened)
    void opened.catch(() => runtimes.delete(thread))
    return opened
  }

  const providerTransport = providerTransportFrom(options.providers ?? [])
  const alarmScheduler = options.alarm ?? bunAlarmScheduler
  let driver: ReturnType<typeof createThreadDriver>

  const appendTo = async (thread: string, events: ReadonlyArray<Event>): Promise<AppendResult> => {
    const threadRuntime = await runtimeOf(thread)
    const result = await threadRuntime.runtime.runPromise(threadRuntime.store.append(events))
    if (result.appended > 0) threadRuntime.interruptions.interrupt(events)
    if (result.appended > 0) {
      await register(thread)
    }
    return result
  }

  const commitEffect = (
    target: ThreadAddress,
    event: Event,
    lineage: ThreadLineage | undefined,
    link?: Link<unknown, ThreadAddress>,
    call?: ActorInvocationContext
  ): Effect.Effect<void, never> => Effect.promise(async () => {
    const address = formatThreadAddress(target)
    if (lineage !== undefined && (
      lineage.parent.actor !== target.actor || lineage.parent.instance !== target.instance
    )) {
      throw new Error("a child thread must inherit its actor instance")
    }
    if (options.keyOf !== undefined && options.keyOf(event) === undefined && event.type !== "MessageReceived") {
      throw new Error(`unkeyed cross-thread event "${event.type}" to ${address}: every delivered event names its occurrence in its package's key fragment`)
    }
    const thread = threadOf(address)
    const threadRuntime = await runtimeOf(thread)
    const result = await threadRuntime.runtime.runPromise(Effect.gen(function* () {
      const currentSpan = yield* Effect.currentSpan.pipe(Effect.option)
      const stamped = currentSpan._tag === "Some" && (event as { readonly traceparent?: unknown }).traceparent === undefined
        ? ({ ...event, traceparent: traceparentOf(currentSpan.value) } as Event)
        : event
      const current = yield* threadRuntime.store.read
      const created = threadCreatedForDelivery(current, target, lineage, link?.source)
      const landed = link !== undefined && (stamped.type === "MessageReceived" || call !== undefined)
        ? linkedEventOf({ link, event: stamped, ...(call === undefined ? {} : { call }) })
        : stamped
      if (landed.type === "MessageReceived") {
        const id = String((landed as { id?: unknown }).id)
        if (current.some((candidate) => candidate.type === "MessageReceived" && String((candidate as { id?: unknown }).id) === id)) {
          return { appended: 0, head: yield* threadRuntime.store.head }
        }
      }
      const at = (event as { readonly at?: unknown }).at
      if (created === undefined && (typeof at !== "number" || !Number.isFinite(at))) return yield* Effect.die(new Error(`first thread event "${event.type}" must carry a finite at`))
      return yield* threadRuntime.store.append(created === undefined ? [threadCreated(target, lineage, at as number), landed] : [landed])
    }).pipe(Effect.withSpan("commit", { kind: "producer", attributes: { to: address, type: event.type } })))
    if (result.appended > 0) {
      threadRuntime.interruptions.interrupt([event])
      await register(thread, lineage)
      driver.mark(thread)
    }
  }).pipe(Effect.orDie)

  const colocatedTransport: Transport<ThreadAddress, ActorEnvelope> = {
    name: "colocated",
    send: (_destination, envelope) => {
      const placement = envelope.lineage?.placement ?? defaultChildPlacement
      if (placement !== "colocated") return Effect.die(new Error(`Bun host does not support ${JSON.stringify(placement)} thread placement`))
      const lineage = envelope.lineage === undefined ? undefined : { ...envelope.lineage, placement }
      return commitEffect(envelope.link.target, envelope.event, lineage, envelope.link, envelope.call)
    }
  }
  const routes = [
    directoryRoute(colocatedTransport, mappedDirectory((id: ThreadAddress) =>
      id.actor === actorName && id.instance === actorInstance ? id : undefined
    ), isActorEnvelope, (envelope) => envelope.link.target),
    directoryRoute(providerTransport, mappedDirectory<ProviderEndpoint, ProviderEndpoint>((endpoint) => endpoint), isProviderEnvelope, (envelope) => envelope.link.target),
    ...(options.routes ?? [])
  ]
  const router = Layer.succeed(Router, { send: (envelope) => sendThrough(routes, envelope) })
  const self = (thread: string): string => `${actorName}:${actorInstance}:${thread}`

  const layersOf = async (thread: string): Promise<Layer.Layer<R | EventLog>> => {
    const threadRuntime = await runtimeOf(thread)
    const store: ThreadEventStore = {
      ...threadRuntime.store,
      append: (events) => threadRuntime.store.append(events).pipe(Effect.tap((result) => result.appended > 0
        ? Effect.all([
            Effect.sync(() => threadRuntime.interruptions.interrupt(events)),
            Effect.promise(() => register(thread))
          ]).pipe(Effect.asVoid)
        : Effect.void))
    }
    const ports = Layer.mergeAll(
      Layer.succeed(EventLog, eventLogFrom(store)), router,
      Layer.succeed(EffectInterruptions, threadRuntime.interruptions),
      Layer.succeed(KeyValueStore.KeyValueStore, threadRuntime.workspace),
      Layer.succeed(Self, parseThreadAddress(self(thread))), bunSandboxFor(options.sandbox ?? {})
    )
    const extra = (options.layersFor ?? (() => Layer.empty as unknown as BunThreadEnv<R>))(thread)
    return Layer.mergeAll(extra.pipe(Layer.provide(ports)), ports) as Layer.Layer<R | EventLog>
  }

  const cancelAlarm = async (thread: string): Promise<void> => {
    const threadRuntime = await runtimeOf(thread)
    threadRuntime.alarm?.handle.cancel()
    delete threadRuntime.alarm
  }
  const synchronizeAlarm = async (thread: string): Promise<void> => {
    const threadRuntime = await runtimeOf(thread)
    const actor = options.actorFor(thread)
    const methods = actor !== undefined && "methods" in actor
      ? (actor as Actor<R> & { readonly methods: ActorMethods }).methods
      : undefined
    const deadlineAt = earliestDeadlineOf(
      await threadRuntime.runtime.runPromise(threadRuntime.store.read),
      methods
    )
    if (threadRuntime.alarm?.deadlineAt === deadlineAt) return
    await cancelAlarm(thread)
    if (deadlineAt === undefined) return
    const handle = alarmScheduler.schedule(deadlineAt, async (at) => {
      const active = await runtimeOf(thread)
      if (active.alarm?.deadlineAt !== deadlineAt) return
      delete active.alarm
      await appendTo(thread, [alarmFired({ scheduledFor: deadlineAt, at })])
      driver.mark(thread)
      await drive()
    })
    threadRuntime.alarm = { deadlineAt, handle }
  }

  driver = createThreadDriver({
    ...(options.driver === undefined ? {} : { policy: options.driver }),
    ...(options.pick === undefined ? {} : { pick: options.pick }),
    serve: async (thread) => {
      const actor = options.actorFor(thread)
      if (actor === undefined) return
      const threadRuntime = await runtimeOf(thread)
      await threadRuntime.runtime.runPromise(settleActor(actor).pipe(Effect.provide(await layersOf(thread))))
      await synchronizeAlarm(thread)
    }
  })

  const logs = async (): Promise<Map<string, ReadonlyArray<Event>>> => {
    const result = new Map<string, ReadonlyArray<Event>>()
    for (const thread of await threads()) {
      const threadRuntime = await runtimeOf(thread)
      result.set(thread, await threadRuntime.runtime.runPromise(threadRuntime.store.read))
    }
    return result
  }
  const driveGraph = async (): Promise<void> => {
    await driver.drain()
    if (options.edgesOf === undefined) return
    for (;;) {
      const found = deadlocks(await logs(), options.edgesOf)
      if (found.length === 0) return
      for (const knot of found) {
        const victim = victimOf(knot)
        await Effect.runPromise(commitEffect(parseThreadAddress(self(victim.from)), { type: "MessageReceived", id: victim.replyId, outcome: "failed", text: `deadlock: ${[...knot.members, knot.members[0]].join(" waits for ")}`, at: 0 } as Event, undefined))
      }
      await driver.drain()
    }
  }
  let driveTail: Promise<void> = Promise.resolve()
  const drive = (): Promise<void> => {
    const next = driveTail.then(driveGraph)
    driveTail = next.then(() => undefined, () => undefined)
    return next
  }
  const resting = async (): Promise<boolean> => {
    for (const [thread, events] of await logs()) {
      const actor = options.actorFor(thread)
      if (actor !== undefined && !restingActor(actor, events)) return false
    }
    return driver.resting()
  }
  const recover = async (): Promise<void> => {
    for (const thread of await threads()) {
      const threadRuntime = await runtimeOf(thread)
      const events = await threadRuntime.runtime.runPromise(threadRuntime.store.read)
      const created = threadCreatedOf(events)
      if (created !== undefined) {
        const lineage = created.parent === undefined ? undefined : {
          parent: created.parent,
          depth: created.depth,
          ...(created.placement === undefined ? {} : { placement: created.placement })
        }
        await register(thread, lineage, created.at)
      }
      if (options.actorFor(thread) !== undefined) driver.mark(thread)
    }
    await drive()
  }

  return {
    seed: async (thread, events) => { await appendTo(thread, events) },
    read: async (thread) => {
      const threadRuntime = await runtimeOf(thread)
      return threadRuntime.runtime.runPromise(threadRuntime.store.read)
    },
    readPage: async (thread, mark, limit) => {
      const threadRuntime = await runtimeOf(thread)
      return threadRuntime.runtime.runPromise(threadRuntime.store.readPage(mark, limit))
    },
    awaitHead: async (thread, mark, signal) => {
      const threadRuntime = await runtimeOf(thread)
      const next = Stream.fromPubSub(threadRuntime.commits).pipe(
        Stream.filter((head) => head > mark),
        Stream.runHead,
        Effect.flatMap((head) => head._tag === "Some" ? Effect.succeed(head.value) : Effect.interrupt)
      )
      return threadRuntime.runtime.runPromise(next, signal === undefined ? {} : { signal })
    },
    readActorPage,
    actorHead,
    awaitActorHead: async (mark, signal) => {
      const next = Stream.fromPubSub(actorCommits).pipe(
        Stream.filter((head) => head > mark),
        Stream.runHead,
        Effect.flatMap((head) => head._tag === "Some" ? Effect.succeed(head.value) : Effect.interrupt)
      )
      return directoryRuntime.runPromise(next, signal === undefined ? {} : { signal })
    },
    commit: (envelope) => Effect.runPromise(commitEffect(envelope.link.target, envelope.event, envelope.lineage, envelope.link, envelope.call)),
    threads,
    commitRoot: (address, event) => Effect.runPromise(commitEffect(parseThreadAddress(address), event, undefined)),
    wake: (thread) => { driver.mark(thread); return drive() },
    drive,
    recover,
    resting,
    work: driver.work,
    self,
    close: async () => {
      for (const [thread, promised] of runtimes) {
        const threadRuntime = await promised
        await cancelAlarm(thread)
        await threadRuntime.commitDispatcher?.close()
        await threadRuntime.runtime.runPromise(PubSub.shutdown(threadRuntime.commits))
        await threadRuntime.runtime.dispose()
      }
      await directoryRuntime.runPromise(PubSub.shutdown(actorCommits))
      await directoryRuntime.dispose()
    }
  }
}
