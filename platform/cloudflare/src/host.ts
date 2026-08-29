import { Effect, Layer, ManagedRuntime } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { SqliteClient } from "@effect/sql-sqlite-do"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, eventLogFrom, type ThreadEventRow } from "@clavia/tardigrade-core/log"
import { mappedDirectory } from "@clavia/tardigrade-core/communication/directory"
import { Router, directoryRoute, sendThrough, type TransportRoute } from "@clavia/tardigrade-core/communication/router"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"
import { isActorEnvelope, isProviderEnvelope, linkedEventOf, type ActorEnvelope, type Envelope } from "@clavia/tardigrade-core/communication/envelope"
import { formatThreadAddress, type ThreadAddress, type ProviderEndpoint } from "@clavia/tardigrade-core/communication/endpoint"
import type { Link } from "@clavia/tardigrade-core/communication/link"
import { alarmFired, earliestDeadlineOf, type ActorMethodInvocation } from "@clavia/tardigrade-core/actor/method"
import { Self, restingActor, settleActor, type Actor } from "@clavia/tardigrade-core/reconciliation"
import { traceparentOf } from "@clavia/tardigrade-core/log/trace"
import { sameThreadAddress, threadCreated, threadCreatedForDelivery, threadKeys, type ThreadLineage } from "@clavia/tardigrade-core/thread"
import { providerTransportFrom, type Provider } from "@clavia/tardigrade-host/communication/provider"
import { createThreadDriver } from "@clavia/tardigrade-host/driver"
import type { HostPorts } from "@clavia/tardigrade-host/host"
import { CloudflareEventStore, layerWorkspace, type CloudflareThreadStorePolicy } from "./storage"

export type CloudflarePorts = HostPorts | KeyValueStore.KeyValueStore
export type CloudflareThreadEnv<R> = Layer.Layer<Exclude<R, CloudflarePorts>, never, CloudflarePorts>

type LayersFor<R> = [Exclude<R, CloudflarePorts>] extends [never]
  ? { readonly layers?: CloudflareThreadEnv<R> }
  : { readonly layers: CloudflareThreadEnv<R> }

export type CloudflareThreadHostOptions<R> = {
  readonly storage: DurableObjectStorage
  readonly actorName: string
  readonly actorInstance: string
  readonly thread: string
  readonly actor: Actor<R>
  readonly providers?: ReadonlyArray<Provider>
  readonly routes?: ReadonlyArray<TransportRoute>
  readonly keyOf?: (event: Event) => string | undefined
  readonly store?: CloudflareThreadStorePolicy
} & LayersFor<R>

export interface CloudflareThreadHost {
  readonly identity: ThreadAddress
  readonly read: () => Promise<ReadonlyArray<Event>>
  readonly readPage: (mark: number, limit: number) => Promise<ReadonlyArray<ThreadEventRow>>
  readonly commit: (envelope: Envelope<unknown, Event, ThreadAddress>) => Promise<void>
  readonly stage: (envelope: Envelope<unknown, Event, ThreadAddress>) => Promise<void>
  readonly commitRoot: (event: Event) => Promise<void>
  readonly stageRoot: (event: Event) => Promise<void>
  readonly drive: () => Promise<void>
  readonly recover: () => Promise<void>
  readonly nextMethodDeadline: () => Promise<number | undefined>
  readonly recordAlarm: (at: number) => Promise<void>
  readonly resting: () => Promise<boolean>
  readonly work: () => number
  readonly self: string
  readonly close: () => Promise<void>
}

// createCloudflareThreadHost binds one actor thread to Effect SQL over its Durable Object storage.
export async function createCloudflareThreadHost<R = never>(options: CloudflareThreadHostOptions<R>): Promise<CloudflareThreadHost> {
  const identity = { actor: options.actorName, instance: options.actorInstance, thread: options.thread }
  const database = ManagedRuntime.make(SqliteClient.layer({ storage: options.storage }))
  const sql = await database.runPromise(SqliteClient.SqliteClient)
  const workspaceRuntime = ManagedRuntime.make(layerWorkspace(sql))
  const workspaceStore = await workspaceRuntime.runPromise(KeyValueStore.KeyValueStore)
  const workspace = Layer.succeed(KeyValueStore.KeyValueStore, workspaceStore)
  const providerTransport = providerTransportFrom(options.providers ?? [])
  const storeKeyOf = (event: Event): string | undefined => threadKeys.keyOf(event) ?? options.keyOf?.(event)
  const innerEvents = new CloudflareEventStore(sql, storeKeyOf, options.store?.indexKey)
  await Effect.runPromise(innerEvents.initialize())
  const events = options.store?.wrap(innerEvents) ?? innerEvents
  const readEffect = events.read
  const sync = Effect.promise(() => options.storage.sync())

  const commitEffect = (
    target: ThreadAddress,
    event: Event,
    lineage: ThreadLineage | undefined,
    link?: Link<unknown, ThreadAddress>,
    call?: ActorMethodInvocation,
    flush = true
  ): Effect.Effect<void> => {
    const address = formatThreadAddress(target)
    return Effect.gen(function* () {
      if (!sameThreadAddress(target, identity)) {
        return yield* Effect.die(new Error(`delivery target ${address} does not match thread ${formatThreadAddress(identity)}`))
      }
      if (options.keyOf !== undefined && options.keyOf(event) === undefined && event.type !== "MessageReceived") {
        return yield* Effect.die(
          new Error(`unkeyed cross-thread event "${event.type}" to ${address}: every delivered event names its occurrence in its package's key fragment`)
        )
      }
      const currentSpan = yield* Effect.currentSpan.pipe(Effect.option)
      const stamped =
        currentSpan._tag === "Some" && (event as { readonly traceparent?: unknown }).traceparent === undefined
          ? ({ ...event, traceparent: traceparentOf(currentSpan.value) } as Event)
          : event
      const current = yield* readEffect
      const created = threadCreatedForDelivery(current, target, lineage, link?.source)
      const landed = link !== undefined && (stamped.type === "MessageReceived" || call !== undefined)
        ? linkedEventOf({ link, event: stamped, ...(call === undefined ? {} : { call }) })
        : stamped
      const at = (event as { readonly at?: unknown }).at
      if (created === undefined && (typeof at !== "number" || !Number.isFinite(at))) {
        return yield* Effect.die(new Error(`first thread event "${event.type}" must carry a finite at`))
      }
      const appended = yield* events.append(created === undefined ? [threadCreated(target, lineage, at as number), landed] : [landed])
      if (appended > 0) driver.mark(options.thread)
      if (flush) yield* sync
    }).pipe(Effect.withSpan("commit", { kind: "producer", attributes: { to: address, type: event.type } }))
  }

  const localTransport: Transport<ThreadAddress, ActorEnvelope> = {
    name: "local",
    send: (_destination, envelope) => commitEffect(envelope.link.target, envelope.event, envelope.lineage, envelope.link, envelope.call)
  }
  const routes = [
    directoryRoute(
      localTransport,
      mappedDirectory((id: ThreadAddress) =>
        sameThreadAddress(id, identity) ? id : undefined
      ),
      isActorEnvelope,
      (envelope) => envelope.link.target
    ),
    directoryRoute(providerTransport, mappedDirectory<ProviderEndpoint, ProviderEndpoint>((endpoint) => endpoint), isProviderEnvelope, (envelope) => envelope.link.target),
    ...(options.routes ?? [])
  ]
  const router = Layer.succeed(Router, { send: (envelope) => sendThrough(routes, envelope) })
  const self = formatThreadAddress(identity)
  const store = {
    append: (batch: ReadonlyArray<Event>) => events.append(batch).pipe(Effect.tap(() => sync)),
    read: events.read,
    head: events.head,
    readFrom: (mark: number) => events.readFrom(mark),
    readPage: (mark: number, limit: number) => events.readPage(mark, limit)
  }
  const ports = Layer.mergeAll(
    Layer.succeed(EventLog, eventLogFrom(store)),
    router,
    workspace,
    Layer.succeed(Self, identity)
  )
  const layers = (options.layers ?? Layer.empty as unknown as CloudflareThreadEnv<R>)
    .pipe(Layer.provideMerge(ports)) as Layer.Layer<R | EventLog>
  const driver = createThreadDriver({
    serve: async (thread) => {
      if (thread !== options.thread) throw new Error(`driver received foreign thread ${JSON.stringify(thread)}`)
      await Effect.runPromise(settleActor(options.actor).pipe(Effect.provide(layers)))
    }
  })
  let tail: Promise<void> = Promise.resolve()
  const drive = (): Promise<void> => {
    const next = tail.then(() => driver.drain())
    tail = next.then(() => undefined, () => undefined)
    return next
  }
  const recover = async (): Promise<void> => {
    if ((await Effect.runPromise(events.head)) > 0) driver.mark(options.thread)
    await drive()
  }
  const nextMethodDeadline = async (): Promise<number | undefined> => {
    return earliestDeadlineOf(await Effect.runPromise(readEffect))
  }
  const recordAlarm = async (at: number): Promise<void> => {
    const deadline = earliestDeadlineOf(await Effect.runPromise(readEffect))
    if (deadline !== undefined && deadline <= at) {
      const appended = await Effect.runPromise(events.append([alarmFired({ scheduledFor: deadline, at })]))
      if (appended > 0) driver.mark(options.thread)
    }
    await options.storage.sync()
  }
  const resting = async (): Promise<boolean> => {
    return restingActor(options.actor, await Effect.runPromise(readEffect)) && driver.resting()
  }
  return {
    identity,
    read: () => Effect.runPromise(readEffect),
    readPage: (mark, limit) => Effect.runPromise(events.readPage(mark, limit)),
    commit: (envelope) => Effect.runPromise(commitEffect(envelope.link.target, envelope.event, envelope.lineage, envelope.link, envelope.call)),
    stage: (envelope) => Effect.runPromise(commitEffect(envelope.link.target, envelope.event, envelope.lineage, envelope.link, envelope.call, false)),
    commitRoot: (event) => Effect.runPromise(commitEffect(identity, event, undefined)),
    stageRoot: (event) => Effect.runPromise(commitEffect(identity, event, undefined, undefined, undefined, false)),
    drive,
    recover,
    nextMethodDeadline,
    recordAlarm,
    resting,
    work: driver.work,
    self,
    close: async () => {
      await workspaceRuntime.dispose()
      await database.dispose()
    }
  }
}
