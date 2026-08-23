import { Effect, Layer, ManagedRuntime } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { SqliteClient } from "@effect/sql-sqlite-do"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog } from "@clavia/tardigrade-core/event-log"
import { mappedDirectory } from "@clavia/tardigrade-core/communication/directory"
import { Router, directoryRoute, sendThrough, type TransportRoute } from "@clavia/tardigrade-core/communication/router"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"
import { isActorEnvelope, isProviderEnvelope, linkedEventOf, type ActorEnvelope, type Envelope } from "@clavia/tardigrade-core/communication/envelope"
import { formatActorId, isActorId, parseActorId, type ActorId, type ProviderEndpoint } from "@clavia/tardigrade-core/communication/endpoint"
import type { Link } from "@clavia/tardigrade-core/communication/link"
import { Self, restingActor, settleActor, type Actor } from "@clavia/tardigrade-core/actor"
import { Facets } from "@clavia/tardigrade-core/facets"
import { traceparentOf } from "@clavia/tardigrade-core/trace"
import { sameActorId, sameThreadLineage, threadCreated, threadCreatedOf, threadKeys, type ThreadLineage } from "@clavia/tardigrade-core/thread"
import { providerTransportFrom, type Provider } from "@clavia/tardigrade-host/communication/provider"
import { createLaneDriver, type DriverPolicy } from "@clavia/tardigrade-host/driver"
import type { HostPorts } from "@clavia/tardigrade-host/host"
import { CloudflareEventStore, layerWorkspace } from "./storage"

type CloudflarePorts = HostPorts | KeyValueStore.KeyValueStore
type CloudflareLaneEnv<R> = Layer.Layer<Exclude<R, CloudflarePorts>, never, CloudflarePorts>

type LayersFor<R> = [Exclude<R, CloudflarePorts>] extends [never]
  ? { readonly layersFor?: (lane: string) => CloudflareLaneEnv<R> }
  : { readonly layersFor: (lane: string) => CloudflareLaneEnv<R> }

export type CloudflareHostOptions<R> = {
  readonly storage: DurableObjectStorage
  readonly principal: string
  readonly actorFor: (lane: string) => Actor<R> | undefined
  readonly providers?: ReadonlyArray<Provider>
  readonly routes?: ReadonlyArray<TransportRoute>
  readonly driver?: Partial<DriverPolicy>
  readonly pick?: (dirty: ReadonlySet<string>) => string
  readonly keyOf?: (event: Event) => string | undefined
} & LayersFor<R>

export interface CloudflareHost {
  readonly read: (lane: string) => Promise<ReadonlyArray<Event>>
  readonly lanes: () => Promise<ReadonlyArray<string>>
  readonly commit: (envelope: Envelope<unknown, Event, ActorId>) => Promise<void>
  readonly commitRoot: (address: string, event: Event) => Promise<void>
  readonly drive: () => Promise<void>
  readonly recover: () => Promise<void>
  readonly resting: () => Promise<boolean>
  readonly work: () => number
  readonly self: (lane: string) => string
  readonly close: () => Promise<void>
}

const laneOf = (address: string): string => {
  const separator = address.indexOf(":")
  return separator === -1 ? address : address.slice(separator + 1)
}

// createCloudflareHost binds one actor graph to Effect SQL over its Durable Object storage.
export const createCloudflareHost = async <R = never>(options: CloudflareHostOptions<R>): Promise<CloudflareHost> => {
  const database = ManagedRuntime.make(SqliteClient.layer({ storage: options.storage }))
  const sql = await database.runPromise(SqliteClient.SqliteClient)
  const workspaceRuntime = ManagedRuntime.make(layerWorkspace(sql))
  const workspaceStore = await workspaceRuntime.runPromise(KeyValueStore.KeyValueStore)
  const workspace = Layer.succeed(KeyValueStore.KeyValueStore, workspaceStore)
  const providerTransport = providerTransportFrom(options.providers ?? [])
  const storeKeyOf = (event: Event): string | undefined => threadKeys.keyOf(event) ?? options.keyOf?.(event)
  const events = new CloudflareEventStore(sql, storeKeyOf)
  await Effect.runPromise(events.initialize())
  const readEffect = (lane: string): Effect.Effect<ReadonlyArray<Event>> => events.read(lane)
  const sync = Effect.promise(() => options.storage.sync())

  const commitEffect = (
    target: ActorId,
    event: Event,
    lineage: ThreadLineage | undefined,
    link?: Link<unknown, ActorId>
  ): Effect.Effect<void> => {
    const address = formatActorId(target)
    return Effect.gen(function* () {
      if (options.keyOf !== undefined && options.keyOf(event) === undefined && event.type !== "MessageReceived") {
        return yield* Effect.die(
          new Error(`unkeyed cross-lane event "${event.type}" to ${address}: every delivered event names its occurrence in its package's key fragment`)
        )
      }
      const lane = laneOf(address)
      const currentSpan = yield* Effect.currentSpan.pipe(Effect.option)
      const stamped =
        currentSpan._tag === "Some" && (event as { readonly traceparent?: unknown }).traceparent === undefined
          ? ({ ...event, traceparent: traceparentOf(currentSpan.value) } as Event)
          : event
      const current = yield* readEffect(lane)
      const created = threadCreatedOf(current)
      if (current.length > 0 && created === undefined) return yield* Effect.die(new Error(`thread ${address} has no ThreadCreated first event`))
      if (created !== undefined && !sameActorId(created.address, target)) {
        return yield* Effect.die(new Error(`thread ${address} creation address does not match its target`))
      }
      if (lineage !== undefined) {
        if (lineage.depth <= 0 || sameActorId(lineage.parent, target)) {
          return yield* Effect.die(new Error(`thread ${address} has invalid child lineage`))
        }
        if (link === undefined || !isActorId(link.source) || !sameActorId(lineage.parent, link.source)) {
          return yield* Effect.die(new Error(`thread ${address} lineage parent does not match its delivery source`))
        }
        if (created !== undefined && !sameThreadLineage(created, lineage)) {
          return yield* Effect.die(new Error(`thread ${address} already has different lineage`))
        }
      } else if (created === undefined && link !== undefined && isActorId(link.source)) {
        return yield* Effect.die(new Error(`initial actor delivery to ${address} must carry lineage`))
      }
      const landed = link !== undefined && stamped.type === "MessageReceived" ? linkedEventOf({ link, event: stamped }) : stamped
      const at = (event as { readonly at?: unknown }).at
      if (created === undefined && (typeof at !== "number" || !Number.isFinite(at))) {
        return yield* Effect.die(new Error(`first thread event "${event.type}" must carry a finite at`))
      }
      const appended = yield* events.append(
        lane,
        created === undefined ? [threadCreated(target, lineage, at as number), landed] : [landed]
      )
      if (appended > 0) driver.mark(lane)
      yield* sync
    }).pipe(Effect.withSpan("commit", { kind: "producer", attributes: { to: address, type: event.type } }))
  }

  const localTransport: Transport<ActorId, ActorEnvelope> = {
    name: "local",
    send: (_destination, envelope) => commitEffect(envelope.link.target, envelope.event, envelope.lineage, envelope.link)
  }
  const routes = [
    directoryRoute(localTransport, mappedDirectory((id: ActorId) => id.actor === options.principal ? id : undefined), isActorEnvelope, (envelope) => envelope.link.target),
    directoryRoute(providerTransport, mappedDirectory<ProviderEndpoint, ProviderEndpoint>((endpoint) => endpoint), isProviderEnvelope, (envelope) => envelope.link.target),
    ...(options.routes ?? [])
  ]
  const router = Layer.succeed(Router, { send: (envelope) => sendThrough(routes, envelope) })
  const self = (lane: string): string => `${options.principal}:${lane}`
  const portsOf = (lane: string) => Layer.mergeAll(
    Layer.succeed(EventLog, {
      append: (batch) => events.append(lane, batch).pipe(Effect.andThen(sync), Effect.asVoid),
      read: readEffect(lane),
      head: events.head(lane),
      readFrom: (mark) => events.readFrom(lane, mark)
    }),
    router,
    workspace,
    Layer.succeed(Self, parseActorId(self(lane))),
    Layer.succeed(Facets, { read: readEffect })
  )
  const layersOf = (lane: string): Layer.Layer<R | EventLog> => {
    const extra = (options.layersFor ?? (() => Layer.empty as unknown as CloudflareLaneEnv<R>))(lane)
    return extra.pipe(Layer.provideMerge(portsOf(lane))) as Layer.Layer<R | EventLog>
  }
  const driver = createLaneDriver({
    ...(options.driver === undefined ? {} : { policy: options.driver }),
    ...(options.pick === undefined ? {} : { pick: options.pick }),
    serve: async (lane) => {
      const actor = options.actorFor(lane)
      if (actor !== undefined) await Effect.runPromise(settleActor(actor).pipe(Effect.provide(layersOf(lane))))
    }
  })
  let tail: Promise<void> = Promise.resolve()
  const drive = (): Promise<void> => {
    const next = tail.then(() => driver.drain())
    tail = next.then(() => undefined, () => undefined)
    return next
  }
  const lanes = (): Promise<ReadonlyArray<string>> => Effect.runPromise(events.lanes())
  const recover = async (): Promise<void> => {
    for (const lane of await lanes()) if (options.actorFor(lane) !== undefined) driver.mark(lane)
    await drive()
  }
  const resting = async (): Promise<boolean> => {
    for (const lane of await lanes()) {
      const actor = options.actorFor(lane)
      if (actor !== undefined && !restingActor(actor, await Effect.runPromise(readEffect(lane)))) return false
    }
    return driver.resting()
  }
  return {
    read: (lane) => Effect.runPromise(readEffect(lane)),
    lanes,
    commit: (envelope) => Effect.runPromise(commitEffect(envelope.link.target, envelope.event, envelope.lineage, envelope.link)),
    commitRoot: (address, event) => Effect.runPromise(commitEffect(parseActorId(address), event, undefined)),
    drive,
    recover,
    resting,
    work: driver.work,
    self,
    close: async () => {
      await workspaceRuntime.dispose()
      await database.dispose()
    }
  }
}
