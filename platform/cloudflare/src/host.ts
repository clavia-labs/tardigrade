import { actorExecution } from "@clavia/tardigrade-host/execution"
import { commitTracedDelivery } from "@clavia/tardigrade-host/delivery"
import { Effect, Layer, ManagedRuntime } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { SqliteClient } from "@effect/sql-sqlite-do"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, eventLogFrom, type ThreadEventRow } from "@clavia/tardigrade-core/log"
import { mappedDirectory } from "@clavia/tardigrade-core/transport/directory"
import { Router, directoryRoute, sendThrough, type TransportRoute } from "@clavia/tardigrade-core/transport/router"
import type { Transport } from "@clavia/tardigrade-core/transport/transport"
import { isActorEnvelope, isProviderEnvelope, type ActorEnvelope, type Envelope } from "@clavia/tardigrade-core/interaction/envelope"
import { ThreadAllocator, reserveRootThread } from "@clavia/tardigrade-core/actor/allocation"
import { initializingThreadAllocator } from "@clavia/tardigrade-host/allocation"
import { formatThreadAddress, type ThreadAddress, type ProviderEndpoint } from "@clavia/tardigrade-core/transport/endpoint"
import type { Link } from "@clavia/tardigrade-core/transport/link"
import { alarmFired, deadlineCancellationEventsAt, earliestDeadlineOf } from "@clavia/tardigrade-core/interaction/timeout"
import { hostEventKeyOf } from "@clavia/tardigrade-host/event-key"
import { type ActorMethods } from "@clavia/tardigrade-core/actor/method"
import {
  EffectInterruptions,
  Self,
  effectInterruptionRegistry,
  type ActorSource as Actor
} from "@clavia/tardigrade-core/runtime"
import { sameThreadAddress, threadCreated, threadCreatedForDelivery, type ThreadLineage } from "@clavia/tardigrade-core/interaction/relations"
import { providerTransportFrom, type Provider } from "@clavia/tardigrade-host/transport/provider"
import { hostDrive, createThreadDriver } from "@clavia/tardigrade-host/driver"
import { CommitDispatcher, type CommitObserver } from "@clavia/tardigrade-host/commit"
import type { HostPorts } from "@clavia/tardigrade-host/ports"
import { CloudflareEventStore, layerWorkspace, type CloudflareThreadStorePolicy } from "./storage"

export type CloudflarePorts = HostPorts | KeyValueStore.KeyValueStore
export type CloudflareThreadEnv<R> = Layer.Layer<Exclude<R, CloudflarePorts>, never, CloudflarePorts>

type LayersFor<R> = [Exclude<R, CloudflarePorts>] extends [never]
  ? { readonly layers?: CloudflareThreadEnv<R> }
  : { readonly layers: CloudflareThreadEnv<R> }

export type CloudflareThreadHostOptions<R> = {
  readonly initializeRoot?: (target: ThreadAddress, at: number) => Promise<void>
  readonly storage: DurableObjectStorage
  readonly threadAllocator?: typeof ThreadAllocator.Service
  readonly actorName: string
  readonly actorInstance: string
  readonly thread: string
  readonly actor: Actor<R>
  readonly providers?: ReadonlyArray<Provider>
  readonly routes?: ReadonlyArray<TransportRoute>
  readonly keyOf?: (event: Event) => string | undefined
  readonly store?: CloudflareThreadStorePolicy
  readonly commitObserver?: CommitObserver
  readonly retainCommitTask?: (task: Promise<void>) => void
} & LayersFor<R>

export interface CloudflareThreadHost {
  readonly identity: ThreadAddress
  readonly read: () => Promise<ReadonlyArray<Event>>
  readonly readPage: (mark: number, limit: number) => Promise<ReadonlyArray<ThreadEventRow>>
  readonly commit: (envelope: Envelope<unknown, Event, ThreadAddress>) => Promise<void>
  readonly stage: (envelope: Envelope<unknown, Event, ThreadAddress>) => Promise<void>
  readonly commitRoot: (event: Event) => Promise<void>
  readonly initializeRoot: (at: number) => Promise<void>
  readonly copyPrefix: (events: ReadonlyArray<Event>) => Promise<{ readonly appended: number; readonly head: number }>
  readonly stageRoot: (event: Event) => Promise<void>
  readonly publishStaged: () => void
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
  const allocator: typeof ThreadAllocator.Service = options.threadAllocator ?? {
    allocate: (request) => request.kind === "root" && request.key === undefined &&
      request.coordinate.actor === identity.actor && request.coordinate.instance === identity.instance && request.coordinate.thread === identity.thread
      ? Effect.succeed(identity) : Effect.die(new Error("thread allocation requires an actor directory"))
  }
  const methods = "methods" in options.actor
    ? (options.actor as Actor<R> & { readonly methods: ActorMethods }).methods
    : undefined
  const database = ManagedRuntime.make(SqliteClient.layer({ storage: options.storage }))
  const sql = await database.runPromise(SqliteClient.SqliteClient)
  const workspaceRuntime = ManagedRuntime.make(layerWorkspace(sql))
  const workspaceStore = await workspaceRuntime.runPromise(KeyValueStore.KeyValueStore)
  const workspace = Layer.succeed(KeyValueStore.KeyValueStore, workspaceStore)
  const providerTransport = providerTransportFrom(options.providers ?? [])
  const storeKeyOf = (event: Event): string | undefined =>
    hostEventKeyOf(event, options.keyOf)
  const events = new CloudflareEventStore(sql, storeKeyOf, options.store?.codec, options.store?.indexKey)
  const interruptions = effectInterruptionRegistry()
  await Effect.runPromise(events.initialize())
  const sync = Effect.promise(() => options.storage.sync())
  const commitDispatcher = options.commitObserver === undefined
    ? undefined
    : new CommitDispatcher(options.commitObserver, options.retainCommitTask)
  let stagedHead = 0
  let creation: ReturnType<typeof threadCreated> | undefined
  let creationLoaded = false
  const publish = (head: number): Effect.Effect<void> => Effect.sync(() => {
    commitDispatcher?.offer({ ...identity, head })
  })
  const syncCommit = (result: { readonly appended: number; readonly head: number }): Effect.Effect<void> =>
    result.appended > 0 ? Effect.andThen(sync, publish(result.head)) : Effect.void

  const commitEffect = (
    target: ThreadAddress,
    event: Event,
    lineage: ThreadLineage | undefined,
    link?: Link<unknown, ThreadAddress>,
    call?: unknown,
    flush = true,
    allocated = false
  ): Effect.Effect<void> => {
    const address = formatThreadAddress(target)
    return Effect.gen(function* () {
      if (!sameThreadAddress(target, identity)) {
        return yield* Effect.die(new Error(`delivery target ${address} does not match thread ${formatThreadAddress(identity)}`))
      }
      const result = yield* commitTracedDelivery({ target, event, lineage, link, call, allocated, keyOf: options.keyOf }, {
        read: Effect.gen(function* () {
          if (!creationLoaded) {
            const first = yield* events.first
            creation = threadCreatedForDelivery(first === undefined ? [] : [first], target, lineage, link?.source)
            creationLoaded = true
          }
          return creation === undefined ? [] : [creation]
        }),
        head: events.head,
        append: (batch) => events.append(batch),
        reserveRoot: reserveRootThread(target).pipe(Effect.provideService(ThreadAllocator, allocator), Effect.asVoid)
      })
      if (result.opened) {
        const first = yield* events.first
        creation = threadCreatedForDelivery(first === undefined ? [] : [first], target, lineage, link?.source)
      }
      if (result.appended > 0) interruptions.interrupt([result.landed])
      if (result.appended > 0) driver.mark(options.thread)
      if (flush) yield* syncCommit(result)
      else if (result.appended > 0) stagedHead = Math.max(stagedHead, result.head)
    })
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
  const wrappedAppend = (batch: ReadonlyArray<Event>) => events.append(batch).pipe(
    Effect.tap((result) => result.appended > 0 ? Effect.sync(() => interruptions.interrupt(batch)) : Effect.void),
    Effect.tap(syncCommit)
  )
  const store = {
    append: wrappedAppend,
    copyPrefix: wrappedAppend,
    read: events.read,
    head: events.head,
    readFrom: (mark: number) => events.readFrom(mark),
    readPage: (mark: number, limit: number) => events.readPage(mark, limit)
  }
  const ports = Layer.mergeAll(
    Layer.succeed(EventLog, eventLogFrom(store)),
    Layer.succeed(EffectInterruptions, interruptions),
    router,
    workspace,
    Layer.succeed(Self, identity),
    Layer.succeed(ThreadAllocator, initializingThreadAllocator(
      allocator,
      options.initializeRoot ?? ((target, at) => {
        if (target.actor !== identity.actor || target.instance !== identity.instance || target.thread !== identity.thread) {
          return Promise.reject(new Error("root initialization requires the owning host"))
        }
        return Effect.runPromise(commitEffect(identity, threadCreated(identity, undefined, at), undefined, undefined, undefined, true, true))
      })
    ))
  )
  const layers = (options.layers ?? Layer.empty as unknown as CloudflareThreadEnv<R>)
    .pipe(Layer.provideMerge(ports)) as Layer.Layer<R | EventLog>
  const execution = actorExecution(options.actor)
  const driver = createThreadDriver({
    serve: async (thread) => {
      if (thread !== options.thread) throw new Error(`driver received foreign thread ${JSON.stringify(thread)}`)
      await Effect.runPromise(execution.settle.pipe(Effect.provide(layers)))
    }
  })
  const { drive } = hostDrive(() => driver.drain())
  const recover = async (): Promise<void> => {
    if ((await Effect.runPromise(events.head)) > 0) driver.mark(options.thread)
    await drive()
  }
  const nextMethodDeadline = async (): Promise<number | undefined> => {
    return earliestDeadlineOf(await Effect.runPromise(events.read), methods)
  }
  // recordAlarm commits each alarm with its crossed deadline cancellations (test/actor.workers.ts, "an alarm commits its deadline cancellation atomically").
  const recordAlarm = async (at: number): Promise<void> => {
    const log = await Effect.runPromise(events.read)
    const deadline = earliestDeadlineOf(log, methods)
    if (deadline !== undefined && deadline <= at) {
      const result = await Effect.runPromise(store.append([
        alarmFired({ scheduledFor: deadline, at }),
        ...(methods === undefined ? [] : deadlineCancellationEventsAt(log, methods, at))
      ]))
      if (result.appended > 0) driver.mark(options.thread)
    } else {
      await options.storage.sync()
    }
  }
  const resting = async (): Promise<boolean> => {
    if (!driver.resting()) return false
    return Effect.runPromise(execution.isResting(events.read))
  }
  return {
    identity,
    read: () => Effect.runPromise(events.read),
    readPage: (mark, limit) => Effect.runPromise(events.readPage(mark, limit)),
    commit: (envelope) => Effect.runPromise(commitEffect(envelope.link.target, envelope.event, envelope.lineage, envelope.link, envelope.call)),
    stage: (envelope) => Effect.runPromise(commitEffect(envelope.link.target, envelope.event, envelope.lineage, envelope.link, envelope.call, false)),
    commitRoot: (event) => Effect.runPromise(commitEffect(identity, event, undefined)),
    initializeRoot: (at) => Effect.runPromise(commitEffect(identity, threadCreated(identity, undefined, at), undefined, undefined, undefined, true, true)),
    copyPrefix: (events) => Effect.runPromise(store.copyPrefix(events)),
    stageRoot: (event) => Effect.runPromise(commitEffect(identity, event, undefined, undefined, undefined, false)),
    publishStaged: () => {
      if (stagedHead === 0) return
      const head = stagedHead
      stagedHead = 0
      commitDispatcher?.offer({ ...identity, head })
    },
    drive,
    recover,
    nextMethodDeadline,
    recordAlarm,
    resting,
    work: driver.work,
    self,
    close: async () => {
      await commitDispatcher?.close()
      await workspaceRuntime.dispose()
      await database.dispose()
    }
  }
}
