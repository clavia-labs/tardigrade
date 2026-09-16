import type { HostPorts, ThreadEnv } from "../ports"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { threadSupervisorDriver, threadSupervisorKeyOf } from "../thread-supervisor"
import { hostThreadAllocator } from "../allocation"
import { ThreadProvisioner, threadSupervisor, threadAllocationKey, type ThreadSupervisor } from "@clavia/tardigrade-core/actor/supervisor"
import { threadProvisioner } from "../thread-provisioner"
import { actorThreadsOf } from "@clavia/tardigrade-core/actor/events"
import { threadExecutions } from "../execution"
import { commitDelivery, validateDelivery } from "../delivery"
import { Effect, Layer } from "effect"
import { ThreadAllocator, allocateThread, type ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import { instanceThreadAllocator, registeredThreadAllocator, memoryThreadDirectory, type ThreadAllocationPolicy } from "../allocation"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark, type AppendOptions, type AppendResult } from "@clavia/tardigrade-core/log"
import { mappedDirectory } from "@clavia/tardigrade-core/transport/directory"
import { Router, directoryRoute, sendThrough, type TransportRoute } from "@clavia/tardigrade-core/transport/router"
import type { Transport } from "@clavia/tardigrade-core/transport/transport"
import { isActorEnvelope, isProviderEnvelope, type ActorEnvelope, type Envelope } from "@clavia/tardigrade-core/interaction/envelope"
import {
  formatThreadAddress,
  parseThreadAddress,
  type ThreadAddress,
  type ProviderEndpoint
} from "@clavia/tardigrade-core/transport/endpoint"
import type { Link } from "@clavia/tardigrade-core/transport/link"
import { hostEventKeyOf } from "../event-key"
import {
  EffectInterruptions,
  Self,
  effectInterruptionRegistry,
  restingActor,
  type ActorSource as Actor
} from "@clavia/tardigrade-core/runtime"
import { deadlocks, victimOf, type EdgesOf } from "../deadlock"
import { providerTransportFrom, type Provider } from "../transport/provider"
import { hostDrive, createThreadDriver, type DriverPolicy } from "../driver"
import { threadCreatedOf, sameThreadLineage, type ThreadLineage } from "@clavia/tardigrade-core/interaction/relations"
import { forkBatchFor, forkRootAllocation, type ForkThreadRequest } from "../fork"

// A host runs the emergent graph: many threads, one router, one driver.
// This is the default binding: in-process and volatile, semantics only.
// A binding that adds physics (durable storage, real alarms, isolation)
// earns a qualified name and must keep every guarantee here; the
// conformance contract is packages/host/tla/Driver.tla and packages/core/tla/interaction/Delivery.tla.

type LayersFor<R> = [Exclude<R, HostPorts>] extends [never]
  ? { readonly layersFor?: (thread: string) => ThreadEnv<R> }
  : { readonly layersFor: (thread: string) => ThreadEnv<R> }

// HostOptions binds a host to its owner's world. actorFor names a
// thread's reactors; a thread with none is a sink (a registry, a mirror)
// and delivery still lands. layersFor supplies the rest of R; the host
// binds HostPorts. A missing LanguageModel is a type error.
export type HostOptions<R> = {
  readonly supervisor?: ThreadSupervisor
  readonly allocation?: ThreadAllocationPolicy
  readonly threadAllocator?: typeof ThreadAllocator.Service
  readonly actorName?: string
  readonly actorInstance?: string
  readonly actorFor: (thread: string) => Actor<R> | undefined
  readonly providers?: ReadonlyArray<Provider>
  // routes extends this host's local and provider directories with platform-owned destinations.
  readonly routes?: ReadonlyArray<TransportRoute>
  // edgesOf arms the deadlock sentinel: after a drive drains, the host
  // breaks each await cycle among resting threads by failing one victim
  // edge with a synthetic error reply, then drives on. Without it a
  // cycle rests forever (packages/core/tla/interaction/Delivery.tla,
  // DeliveryDeadlock).
  readonly edgesOf?: EdgesOf
  // driver states the graph-wide settlement capacity.
  readonly driver?: Partial<DriverPolicy>
  // pick chooses which eligible dirty thread the driver serves next; the default is insertion
  // order. Service order must not change any outcome: the confluence property test shuffles this
  // seam.
  readonly pick?: (dirty: ReadonlySet<string>) => string
  // keyOf is the composed dedup-key derivation (composeKeys). When
  // given, the host enforces the membrane: it refuses an unkeyed
  // cross-thread delivery loudly. MessageReceived is exempt only because
  // its key is its own id, deduped by `seen` here.
  readonly keyOf?: (e: Event) => string | undefined
} & LayersFor<R>

export interface Host {
  readonly allocate: (request: ThreadAllocation) => Promise<ThreadAddress>
  readonly assignThread: (request: ThreadAllocation) => Promise<ThreadAddress>
  readonly reserveThread: (request: ThreadAllocation) => Promise<ThreadAddress>
  readonly forkThread: (request: ForkThreadRequest) => Promise<ThreadAddress>
  // seed appends without waking the thread: test and bootstrap ingress.
  readonly seed: (thread: string, events: ReadonlyArray<Event>) => void
  readonly read: (thread: string) => ReadonlyArray<Event>
  // commit persists one addressed envelope, including child creation lineage when present.
  readonly commit: (envelope: Envelope<unknown, Event, ThreadAddress>) => Promise<void>
  // commitRoot injects an unlinked root event and marks its thread owed a visit.
  readonly commitRoot: (address: string, event: Event) => Promise<void>
  // wake marks a thread owed a visit and drives: what a binding's backup
  // alarm does, and what tests do after seeding a thread by hand.
  readonly wake: (thread: string) => Promise<void>
  // drive serves every dirty thread's reactors to quiescence, following
  // deliveries onto threads they dirty, until the whole graph is quiet.
  // This loop is this binding's payment of Driver.tla's fairness:
  // while the process lives, every owed serve runs.
  readonly drive: () => Promise<void>
  // resting is the graph-wide quiescence question over threads with actors.
  readonly resting: () => boolean
  // router is the host's router as a Layer, for environments built
  // outside layersFor.
  readonly router: Layer.Layer<Router>
  readonly self: (thread: string) => string
}

const threadOf = (address: string): string => parseThreadAddress(address).thread

export const createHost = <R = never>(options: HostOptions<R>): Host => {
  const actorName = options.actorName ?? "mem"
  const actorInstance = options.actorInstance ?? "main"
  const threads = new Map<string, ReadonlyArray<Event>>()
  const interruptions = new Map<string, ReturnType<typeof effectInterruptionRegistry>>()
  const executionOf = threadExecutions<R>()
  const interruptionsOf = (thread: string) => {
    const current = interruptions.get(thread)
    if (current !== undefined) return current
    const created = effectInterruptionRegistry()
    interruptions.set(thread, created)
    return created
  }
  const providerTransport = providerTransportFrom(options.providers ?? [])
  const storeKeyOf = (event: Event): string | undefined =>
    hostEventKeyOf(event, options.keyOf)

  const read = (thread: string): ReadonlyArray<Event> => threads.get(thread) ?? []
  const supervisorEvents: Event[] = []
  const definition = options.supervisor ?? threadSupervisor()
  const actorDirectories = new Map([[JSON.stringify([actorName, actorInstance]), supervisorEvents]])
  const assignments = memoryThreadDirectory((target, existingRoot, request) => {
    const events = read(target.thread)
    const created = threadCreatedOf(events)
    if (created !== undefined && request.kind === "child" && sameThreadLineage(created, { parent: request.parent, depth: created.depth,
      ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }), ...(request.placement === undefined ? {} : { placement: request.placement }) })) return false
    return events.length > 0 && (!existingRoot || events[0]?.parent !== undefined)
  }, definition.methods.requestThread, actorDirectories)
  const localAllocator = instanceThreadAllocator({ actor: actorName, instance: actorInstance }, registeredThreadAllocator(assignments, options.allocation))
  const prepare = (target: ThreadAddress, request: ThreadAllocation): Promise<ThreadAddress> => Effect.runPromise(allocator.ensure(target, request))
  // append implements guarantee 5 of the log port (packages/core/src/log/service.ts): a keyed
  // redelivery is absorbed. With keys deciding commitment (Actor.keyOf), the library tier
  // must keep the platform store's promise, or a re-parked attempt's BlockedOn lands twice
  // here and once there.
  const append = (thread: string, events: ReadonlyArray<Event>, options: AppendOptions = {}): AppendResult => {
    const current = read(thread)
    if (options.expectedHead !== undefined && current.length !== options.expectedHead) {
      return { appended: 0, head: current.length }
    }
    const recorded = new Set<string>()
    for (const e of current) {
      const key = storeKeyOf(e)
      if (key !== undefined) recorded.add(key)
    }
    const landing: Event[] = []
    for (const e of events) {
      const key = storeKeyOf(e)
      if (key !== undefined) {
        if (recorded.has(key)) continue
        recorded.add(key)
      }
      landing.push(e)
    }
    threads.set(thread, [...current, ...landing])
    interruptionsOf(thread).interrupt(landing)
    return { appended: landing.length, head: current.length + landing.length }
  }
  const seed = (thread: string, events: ReadonlyArray<Event>): void => { append(thread, events) }
  const commitAt = async (
    target: ThreadAddress,
    event: Event,
    lineage: ThreadLineage | undefined,
    link?: Link<unknown, ThreadAddress>,
    call?: unknown
  ): Promise<void> => {
    const thread = threadOf(formatThreadAddress(target))
    validateDelivery({ target, event, lineage, link, call, keyOf: options.keyOf }, read(thread))
    await prepare(target, lineage === undefined ? { kind: "root", coordinate: target }
      : { kind: "child", parent: lineage.parent, child: childKeyOf(target.thread),
        ...(lineage.maxDepth === undefined ? {} : { maxDepth: lineage.maxDepth }), ...(lineage.placement === undefined ? {} : { placement: lineage.placement }) })
    const result = await Effect.runPromise(commitDelivery({ target, event, lineage, link, call, keyOf: options.keyOf }, {
      read: Effect.sync(() => read(thread)),
      head: Effect.sync(() => read(thread).length),
      append: (batch) => Effect.sync(() => {
        const before = read(thread).length
        append(thread, batch)
        return { appended: read(thread).length - before, head: read(thread).length }
      })
    }))
    if (result.appended > 0) driver.mark(thread)
  }

  const commit = (envelope: Envelope<unknown, Event, ThreadAddress>): Promise<void> =>
    commitAt(envelope.link.target, envelope.event, envelope.lineage, envelope.link, envelope.call)

  const commitRoot = (address: string, event: Event): Promise<void> =>
    commitAt(parseThreadAddress(address), event, undefined)

  const localTransport: Transport<ThreadAddress, ActorEnvelope> = {
    name: "local",
    send: (_destination, envelope) => Effect.promise(() => commit(envelope))
  }
  const routes = [
    directoryRoute(
      localTransport,
      mappedDirectory((id: ThreadAddress) =>
        id.actor === actorName && id.instance === actorInstance ? id : undefined
      ),
      isActorEnvelope,
      (envelope) => envelope.link.target
    ),
    directoryRoute(
      providerTransport,
      mappedDirectory<ProviderEndpoint, ProviderEndpoint>((endpoint) => endpoint),
      isProviderEnvelope,
      (envelope) => envelope.link.target
    ),
    ...(options.routes ?? [])
  ]
  const router = Layer.succeed(Router, {
    send: (envelope) => sendThrough(routes, envelope)
  })

  const self = (thread: string): string => formatThreadAddress({ actor: actorName, instance: actorInstance, thread })

  const supervisor = threadSupervisorDriver(definition, withWatermark({
    read: Effect.succeed(supervisorEvents),
    append: (events) => Effect.sync(() => {
      const keys = new Set(supervisorEvents.map((event) => threadSupervisorKeyOf(definition, event)))
      for (const event of events) {
        const key = threadSupervisorKeyOf(definition, event)
        if (key !== undefined && keys.has(key)) continue
        supervisorEvents.push(event)
        if (key !== undefined) keys.add(key)
      }
    })
  }), Layer.succeed(ThreadProvisioner, threadProvisioner({
    read: (target) => Effect.sync(() => read(target.thread)),
    append: (target, events, options) => Effect.sync(() => append(target.thread, events, options)),
    register: (created) => Effect.sync(() => driver.mark(created.address.thread))
  })), (operation) => Effect.runPromise(operation.pipe(
    Effect.provide(router), Effect.provideService(Self, { actor: actorName, instance: actorInstance, thread: "" })
  )))
  const allocator = hostThreadAllocator({
    supervisor,
    read: async (target) => read(target.thread),
    owns: (target) => target.actor === actorName && target.instance === actorInstance,
    record: async (target) => actorThreadsOf(supervisorEvents).find((entry) => entry.thread === target.thread),
    reserve: async (request) => {
      const target = await Effect.runPromise(allocateThread(request).pipe(Effect.provideService(ThreadAllocator, options.threadAllocator ?? localAllocator)))
      if (target.actor !== actorName || target.instance !== actorInstance) return target
      const assigned = await Effect.runPromise(assignments.claim(threadAllocationKey(request), target, request.kind === "root", request))
      if (assigned !== target.thread) throw new Error("thread reservation conflicts with an existing assignment")
      return target
    }
  })

  const portsOf = (thread: string) =>
    Layer.mergeAll(
      Layer.succeed(
        EventLog,
        withWatermark({
          append: (events: ReadonlyArray<Event>) => Effect.sync(() => append(thread, events)),
          read: Effect.sync(() => read(thread))
        })
      ),
      router,
      Layer.succeed(ThreadAllocator, allocator),
      Layer.succeed(EffectInterruptions, interruptionsOf(thread)),
      Layer.succeed(Self, parseThreadAddress(self(thread)))
    )

  // Exclude is not distributive over a generic R, so the merge is named
  // here as the env settleActor requires (packages/host/tla/Driver.tla, EventuallyServed).
  const layersOf = (thread: string): Layer.Layer<R | EventLog> => {
    const extra = (options.layersFor ?? (() => Layer.empty as unknown as ThreadEnv<R>))(thread)
    return extra.pipe(Layer.provideMerge(portsOf(thread))) as Layer.Layer<R | EventLog>
  }

  const driver = createThreadDriver({
    ...(options.driver === undefined ? {} : { policy: options.driver }),
    ...(options.pick === undefined ? {} : { pick: options.pick }),
    serve: async (thread) => {
      const actor = options.actorFor(thread)
      if (actor === undefined) return
      await supervisor.ensureReady(parseThreadAddress(self(thread)))
      await Effect.runPromise(
        executionOf(thread, actor).settle.pipe(Effect.provide(layersOf(thread)))
      )
    }
  })

  const drain = (): Promise<void> => driver.drain()

  const driveGraph = async (): Promise<void> => {
    await drain()
    if (options.edgesOf === undefined) return
    // A quiet graph may still be knotted: the sentinel fails one
    // victim per cycle and drives the fallout until no cycles remain.
    for (;;) {
      const found = deadlocks(threads, options.edgesOf)
      if (found.length === 0) return
      for (const knot of found) {
        const victim = victimOf(knot)
        await commitRoot(self(victim.from), {
          type: "MessageReceived",
          id: victim.replyId,
          outcome: "failed",
          text: `deadlock: ${[...knot.members, knot.members[0]].join(" waits for ")}`,
          at: 0
        } as Event)
      }
      await drain()
    }
  }

  const { drive } = hostDrive(driveGraph)

  const resting = (): boolean => {
    for (const [thread, events] of threads) {
      const actor = options.actorFor(thread)
      if (actor !== undefined && !restingActor(actor, events)) return false
    }
    return driver.resting()
  }

  const prepareRestored = async (thread: string, ancestors: ReadonlySet<string> = new Set()): Promise<void> => {
    if (ancestors.has(thread)) throw new Error(`thread lineage contains a cycle at ${JSON.stringify(thread)}`)
    const created = threadCreatedOf(read(thread))
    if (created?.parent !== undefined) await prepareRestored(created.parent.thread, new Set([...ancestors, thread]))
    if (created !== undefined) await prepare(created.address, created.parent === undefined
      ? { kind: "root", coordinate: created.address }
      : { kind: "child", parent: created.parent, child: childKeyOf(thread),
        ...(created.maxDepth === undefined ? {} : { maxDepth: created.maxDepth }), ...(created.placement === undefined ? {} : { placement: created.placement }) })
  }

  const wake = async (thread: string): Promise<void> => {
    await prepareRestored(thread)
    driver.mark(thread)
    return drive()
  }

  // forkThread publishes the destination identity and detached prefix at an empty log head (host.test.ts, "concurrent forks of one name land once").
  const forkThread = async (request: ForkThreadRequest): Promise<ThreadAddress> => {
    const sourceEvents = read(request.source)
    const source = { actor: actorName, instance: actorInstance, thread: request.source }
    forkBatchFor(sourceEvents, { source, seq: request.seq, dest: request.name ?? "" }, Date.now())
    return Effect.runPromise(allocator.allocate(forkRootAllocation(source, request.name, { source, seq: request.seq })))
  }

  return { seed, read, commit, commitRoot, drive, wake, resting, router, self,
    allocate: (request) => Effect.runPromise(allocator.allocate(request)),
    assignThread: (request) => Effect.runPromise(allocator.allocate(request)),
    reserveThread: (request) => Effect.runPromise(localAllocator.allocate(request)),
    forkThread }
}
