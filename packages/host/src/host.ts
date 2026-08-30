import { Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { mappedDirectory } from "@clavia/tardigrade-core/communication/directory"
import { Router, directoryRoute, sendThrough, type TransportRoute } from "@clavia/tardigrade-core/communication/router"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"
import {
  isActorEnvelope,
  isProviderEnvelope,
  linkedEventOf,
  type ActorEnvelope,
  type Envelope
} from "@clavia/tardigrade-core/communication/envelope"
import {
  formatThreadAddress,
  parseThreadAddress,
  type ThreadAddress,
  type ProviderEndpoint
} from "@clavia/tardigrade-core/communication/endpoint"
import type { Link } from "@clavia/tardigrade-core/communication/link"
import { methodIngressKeyOf, type ActorInvocationContext } from "@clavia/tardigrade-core/actor/method"
import {
  EffectInterruptions,
  Self,
  effectInterruptionRegistry,
  restingActor,
  settleActor,
  type Actor
} from "@clavia/tardigrade-core/reconciliation"
import { deadlocks, victimOf, type EdgesOf } from "./deadlock"
import { providerTransportFrom, type Provider } from "./communication/provider"
import { createThreadDriver, type DriverPolicy } from "./driver"
import { threadCreated, threadCreatedForDelivery, threadKeys, type ThreadLineage } from "@clavia/tardigrade-core/thread"

// A host runs the emergent graph: many threads, one router, one driver.
// This is the default binding: in-process and volatile, semantics only.
// A binding that adds physics (durable storage, real alarms, isolation)
// earns a qualified name and must keep every guarantee here; the
// conformance contract is packages/core/tla/runtime/Driver.tla and packages/core/tla/communication/Delivery.tla.

// HostPorts are the services every host binds per thread: the log, the
// router, this thread's address, and the read over its siblings' logs.
// layersFor may require them and must not provide them.
export type HostPorts = EventLog | Router | Self

// ThreadEnv is the rest of an actor's R: what the host does not bind.
// Construction may require HostPorts; Layer.provideMerge discharges them.
export type ThreadEnv<R> = Layer.Layer<Exclude<R, HostPorts>, never, HostPorts>

type LayersFor<R> = [Exclude<R, HostPorts>] extends [never]
  ? { readonly layersFor?: (thread: string) => ThreadEnv<R> }
  : { readonly layersFor: (thread: string) => ThreadEnv<R> }

// HostOptions binds a host to its owner's world. actorFor names a
// thread's reactors; a thread with none is a sink (a registry, a mirror)
// and delivery still lands. layersFor supplies the rest of R; the host
// binds EventLog, Router, and Self. A missing Infer is a type error.
export type HostOptions<R> = {
  readonly actorName?: string
  readonly actorInstance?: string
  readonly actorFor: (thread: string) => Actor<R> | undefined
  readonly providers?: ReadonlyArray<Provider>
  // routes extends this host's local and provider directories with platform-owned destinations.
  readonly routes?: ReadonlyArray<TransportRoute>
  // edgesOf arms the deadlock sentinel: after a drive drains, the host
  // breaks each await cycle among resting threads by failing one victim
  // edge with a synthetic error reply, then drives on. Without it a
  // cycle rests forever (packages/core/tla/communication/Delivery.tla,
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
  // seed appends without waking the thread: test and bootstrap ingress.
  readonly seed: (thread: string, events: ReadonlyArray<Event>) => void
  readonly read: (thread: string) => ReadonlyArray<Event>
  // commit persists one addressed envelope, including child creation lineage when present.
  readonly commit: (envelope: Envelope<unknown, Event, ThreadAddress>) => void
  // commitRoot injects an unlinked root event and marks its thread owed a visit.
  readonly commitRoot: (address: string, event: Event) => void
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

const seen = (events: ReadonlyArray<Event>, event: Event): boolean => {
  if (event.type !== "MessageReceived") return false
  const id = (event as { id?: unknown }).id
  return events.some((e) => e.type === "MessageReceived" && (e as { id?: unknown }).id === id)
}

const eventAt = (event: Event): number => {
  const at = (event as { readonly at?: unknown }).at
  if (typeof at !== "number" || !Number.isFinite(at)) {
    throw new Error(`first thread event "${event.type}" must carry a finite at`)
  }
  return at
}

export const createHost = <R = never>(options: HostOptions<R>): Host => {
  const actorName = options.actorName ?? "mem"
  const actorInstance = options.actorInstance ?? "main"
  const threads = new Map<string, ReadonlyArray<Event>>()
  const interruptions = new Map<string, ReturnType<typeof effectInterruptionRegistry>>()
  const interruptionsOf = (thread: string) => {
    const current = interruptions.get(thread)
    if (current !== undefined) return current
    const created = effectInterruptionRegistry()
    interruptions.set(thread, created)
    return created
  }
  const providerTransport = providerTransportFrom(options.providers ?? [])
  const storeKeyOf = (event: Event): string | undefined =>
    methodIngressKeyOf(event) ?? threadKeys.keyOf(event) ?? options.keyOf?.(event)

  const read = (thread: string): ReadonlyArray<Event> => threads.get(thread) ?? []
  // append implements guarantee 5 of the log port (packages/core/src/log/service.ts): a keyed
  // redelivery is absorbed. With keys deciding commitment (Actor.keyOf), the library tier
  // must keep the platform store's promise, or a re-parked attempt's BlockedOn lands twice
  // here and once there.
  const append = (thread: string, events: ReadonlyArray<Event>): void => {
    const current = read(thread)
    if (options.keyOf === undefined && events.every((event) => threadKeys.keyOf(event) === undefined)) {
      threads.set(thread, [...current, ...events])
      interruptionsOf(thread).interrupt(events)
      return
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
  }
  const seed = (thread: string, events: ReadonlyArray<Event>): void => append(thread, events)

  const commitAt = (
    target: ThreadAddress,
    event: Event,
    lineage: ThreadLineage | undefined,
    link?: Link<unknown, ThreadAddress>,
    call?: ActorInvocationContext
  ): void => {
    const address = formatThreadAddress(target)
    // The membrane: every cross-thread event names its occurrence, or it does not travel.
    // At-least-once lives on these edges, so an unkeyed traveler is a standing double-effect
    // window. The memory host refuses identically to the platform host, so an unkeyed event
    // dies in its author's own test run.
    if (options.keyOf !== undefined && options.keyOf(event) === undefined && event.type !== "MessageReceived") {
      throw new Error(
        `unkeyed cross-thread event "${event.type}" to ${address}: every delivered event names its occurrence in its package's key fragment`
      )
    }
    const thread = threadOf(address)
    const current = read(thread)
    const created = threadCreatedForDelivery(current, target, lineage, link?.source)
    const landed = link !== undefined && (event.type === "MessageReceived" || call !== undefined)
      ? linkedEventOf({ link, event, ...(call === undefined ? {} : { call }) })
      : event
    if (seen(current, landed)) return
    append(thread, created === undefined ? [threadCreated(target, lineage, eventAt(event)), landed] : [landed])
    driver.mark(thread)
  }

  const commit = (envelope: Envelope<unknown, Event, ThreadAddress>): void =>
    commitAt(envelope.link.target, envelope.event, envelope.lineage, envelope.link, envelope.call)

  const commitRoot = (address: string, event: Event): void =>
    commitAt(parseThreadAddress(address), event, undefined)

  const localTransport: Transport<ThreadAddress, ActorEnvelope> = {
    name: "local",
    send: (_destination, envelope) => Effect.sync(() => commit(envelope))
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

  const self = (thread: string): string => `${actorName}:${actorInstance}:${thread}`

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
      Layer.succeed(EffectInterruptions, interruptionsOf(thread)),
      Layer.succeed(Self, parseThreadAddress(self(thread)))
    )

  // Exclude is not distributive over a generic R, so the merge is named
  // here as the env settleActor requires (tla/runtime/Driver.tla, EventuallyServed).
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
      await Effect.runPromise(settleActor(actor).pipe(Effect.provide(layersOf(thread))))
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
        commitRoot(self(victim.from), {
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

  let driveTail: Promise<void> = Promise.resolve()
  const drive = (): Promise<void> => {
    const next = driveTail.then(driveGraph)
    driveTail = next.then(() => undefined, () => undefined)
    return next
  }

  const resting = (): boolean => {
    for (const [thread, events] of threads) {
      const actor = options.actorFor(thread)
      if (actor !== undefined && !restingActor(actor, events)) return false
    }
    return driver.resting()
  }

  const wake = (thread: string): Promise<void> => {
    driver.mark(thread)
    return drive()
  }

  return { seed, read, commit, commitRoot, drive, wake, resting, router, self }
}
