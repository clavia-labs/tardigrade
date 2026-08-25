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
  formatActorId,
  isActorId,
  parseActorId,
  type ActorId,
  type ProviderEndpoint
} from "@clavia/tardigrade-core/communication/endpoint"
import type { Link } from "@clavia/tardigrade-core/communication/link"
import type { ActorMethodInvocation } from "@clavia/tardigrade-core/actor/method"
import { Self, restingActor, settleActor, type Actor } from "@clavia/tardigrade-core/reconciliation"
import { deadlocks, victimOf, type EdgesOf } from "./deadlock"
import { providerTransportFrom, type Provider } from "./communication/provider"
import { createLaneDriver, type DriverPolicy } from "./driver"
import {
  sameActorId,
  sameThreadLineage,
  threadCreated,
  threadCreatedOf,
  threadKeys,
  type ThreadLineage
} from "@clavia/tardigrade-core/thread"

// A host runs the emergent graph: many lanes, one router, one driver.
// This is the default binding: in-process and volatile, semantics only.
// A binding that adds physics (durable storage, real alarms, isolation)
// earns a qualified name and must keep every guarantee here; the
// conformance contract is packages/core/tla/runtime/Driver.tla and packages/core/tla/communication/Delivery.tla.

// HostPorts are the services every host binds per lane: the log, the
// router, this lane's address, and the read over its siblings' logs.
// layersFor may require them and must not provide them.
export type HostPorts = EventLog | Router | Self

// LaneEnv is the rest of an actor's R: what the host does not bind.
// Construction may require HostPorts; Layer.provideMerge discharges them.
export type LaneEnv<R> = Layer.Layer<Exclude<R, HostPorts>, never, HostPorts>

type LayersFor<R> = [Exclude<R, HostPorts>] extends [never]
  ? { readonly layersFor?: (lane: string) => LaneEnv<R> }
  : { readonly layersFor: (lane: string) => LaneEnv<R> }

// HostOptions binds a host to its owner's world. actorFor names a
// lane's reactors; a lane with none is a sink (a registry, a mirror)
// and delivery still lands. layersFor supplies the rest of R; the host
// binds EventLog, Router, and Self. A missing Infer is a type error.
export type HostOptions<R> = {
  readonly principal?: string
  readonly actorFor: (lane: string) => Actor<R> | undefined
  readonly providers?: ReadonlyArray<Provider>
  // routes extends this host's local and provider directories with platform-owned destinations.
  readonly routes?: ReadonlyArray<TransportRoute>
  // edgesOf arms the deadlock sentinel: after a drive drains, the host
  // breaks each await cycle among resting lanes by failing one victim
  // edge with a synthetic error reply, then drives on. Without it a
  // cycle rests forever (packages/core/tla/communication/Delivery.tla,
  // DeliveryDeadlock).
  readonly edgesOf?: EdgesOf
  // driver states the graph-wide settlement capacity.
  readonly driver?: Partial<DriverPolicy>
  // pick chooses which eligible dirty lane the driver serves next; the default is insertion
  // order. Service order must not change any outcome: the confluence property test shuffles this
  // seam.
  readonly pick?: (dirty: ReadonlySet<string>) => string
  // keyOf is the composed dedup-key derivation (composeKeys). When
  // given, the host enforces the membrane: it refuses an unkeyed
  // cross-lane delivery loudly. MessageReceived is exempt only because
  // its key is its own id, deduped by `seen` here.
  readonly keyOf?: (e: Event) => string | undefined
} & LayersFor<R>

export interface Host {
  // seed appends without waking the lane: test and bootstrap ingress.
  readonly seed: (lane: string, events: ReadonlyArray<Event>) => void
  readonly read: (lane: string) => ReadonlyArray<Event>
  // commit persists one addressed envelope, including child creation lineage when present.
  readonly commit: (envelope: Envelope<unknown, Event, ActorId>) => void
  // commitRoot injects an unlinked root event and marks its lane owed a visit.
  readonly commitRoot: (address: string, event: Event) => void
  // wake marks a lane owed a visit and drives: what a binding's backup
  // alarm does, and what tests do after seeding a lane by hand.
  readonly wake: (lane: string) => Promise<void>
  // drive serves every dirty lane's reactors to quiescence, following
  // deliveries onto lanes they dirty, until the whole graph is quiet.
  // This loop is this binding's payment of Driver.tla's fairness:
  // while the process lives, every owed serve runs.
  readonly drive: () => Promise<void>
  // resting is the graph-wide quiescence question over lanes with actors.
  readonly resting: () => boolean
  // router is the host's router as a Layer, for environments built
  // outside layersFor.
  readonly router: Layer.Layer<Router>
  readonly self: (lane: string) => string
}

const laneOf = (address: string): string => {
  const i = address.indexOf(":")
  return i === -1 ? address : address.slice(i + 1)
}

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
  const principal = options.principal ?? "mem"
  const lanes = new Map<string, ReadonlyArray<Event>>()
  const providerTransport = providerTransportFrom(options.providers ?? [])
  const storeKeyOf = (event: Event): string | undefined => threadKeys.keyOf(event) ?? options.keyOf?.(event)

  const read = (lane: string): ReadonlyArray<Event> => lanes.get(lane) ?? []
  // append implements guarantee 5 of the log port (packages/core/src/log/service.ts): a keyed
  // redelivery is absorbed. With keys deciding commitment (Actor.keyOf), the library tier
  // must keep the platform store's promise, or a re-parked attempt's BlockedOn lands twice
  // here and once there.
  const append = (lane: string, events: ReadonlyArray<Event>): void => {
    const current = read(lane)
    if (options.keyOf === undefined && events.every((event) => threadKeys.keyOf(event) === undefined)) {
      lanes.set(lane, [...current, ...events])
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
    lanes.set(lane, [...current, ...landing])
  }
  const seed = (lane: string, events: ReadonlyArray<Event>): void => append(lane, events)

  const commitAt = (
    target: ActorId,
    event: Event,
    lineage: ThreadLineage | undefined,
    link?: Link<unknown, ActorId>,
    call?: ActorMethodInvocation
  ): void => {
    const address = formatActorId(target)
    // The membrane: every cross-lane event names its occurrence, or it does not travel.
    // At-least-once lives on these edges, so an unkeyed traveler is a standing double-effect
    // window. The memory host refuses identically to the platform host, so an unkeyed event
    // dies in its author's own test run.
    if (options.keyOf !== undefined && options.keyOf(event) === undefined && event.type !== "MessageReceived") {
      throw new Error(
        `unkeyed cross-lane event "${event.type}" to ${address}: every delivered event names its occurrence in its package's key fragment`
      )
    }
    const lane = laneOf(address)
    const current = read(lane)
    const created = threadCreatedOf(current)
    if (current.length > 0 && created === undefined) {
      throw new Error(`thread ${address} has no ThreadCreated first event`)
    }
    if (created !== undefined && !sameActorId(created.address, target)) {
      throw new Error(`thread ${address} creation address does not match its target`)
    }
    if (lineage !== undefined) {
      if (lineage.depth <= 0 || sameActorId(lineage.parent, target)) {
        throw new Error(`thread ${address} has invalid child lineage`)
      }
      if (link === undefined || !isActorId(link.source) || !sameActorId(lineage.parent, link.source)) {
        throw new Error(`thread ${address} lineage parent does not match its delivery source`)
      }
      if (created !== undefined && !sameThreadLineage(created, lineage)) {
        throw new Error(`thread ${address} already has different lineage`)
      }
    } else if (created === undefined && link !== undefined && isActorId(link.source)) {
      throw new Error(`initial actor delivery to ${address} must carry lineage`)
    }
    const landed = link !== undefined && (event.type === "MessageReceived" || call !== undefined)
      ? linkedEventOf({ link, event, ...(call === undefined ? {} : { call }) })
      : event
    if (seen(current, landed)) return
    append(lane, created === undefined ? [threadCreated(target, lineage, eventAt(event)), landed] : [landed])
    driver.mark(lane)
  }

  const commit = (envelope: Envelope<unknown, Event, ActorId>): void =>
    commitAt(envelope.link.target, envelope.event, envelope.lineage, envelope.link, envelope.call)

  const commitRoot = (address: string, event: Event): void =>
    commitAt(parseActorId(address), event, undefined)

  const localTransport: Transport<ActorId, ActorEnvelope> = {
    name: "local",
    send: (_destination, envelope) => Effect.sync(() => commit(envelope))
  }
  const routes = [
    directoryRoute(
      localTransport,
      mappedDirectory((id: ActorId) => id.actor === principal ? id : undefined),
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

  const self = (lane: string): string => `${principal}:${lane}`

  const portsOf = (lane: string) =>
    Layer.mergeAll(
      Layer.succeed(
        EventLog,
        withWatermark({
          append: (events: ReadonlyArray<Event>) => Effect.sync(() => append(lane, events)),
          read: Effect.sync(() => read(lane))
        })
      ),
      router,
      Layer.succeed(Self, parseActorId(self(lane)))
    )

  // Exclude is not distributive over a generic R, so the merge is named
  // here as the env settleActor requires (tla/runtime/Driver.tla, EventuallyServed).
  const layersOf = (lane: string): Layer.Layer<R | EventLog> => {
    const extra = (options.layersFor ?? (() => Layer.empty as unknown as LaneEnv<R>))(lane)
    return extra.pipe(Layer.provideMerge(portsOf(lane))) as Layer.Layer<R | EventLog>
  }

  const driver = createLaneDriver({
    ...(options.driver === undefined ? {} : { policy: options.driver }),
    ...(options.pick === undefined ? {} : { pick: options.pick }),
    serve: async (lane) => {
      const actor = options.actorFor(lane)
      if (actor === undefined) return
      await Effect.runPromise(settleActor(actor).pipe(Effect.provide(layersOf(lane))))
    }
  })

  const drain = (): Promise<void> => driver.drain()

  const driveGraph = async (): Promise<void> => {
    await drain()
    if (options.edgesOf === undefined) return
    // A quiet graph may still be knotted: the sentinel fails one
    // victim per cycle and drives the fallout until no cycles remain.
    for (;;) {
      const found = deadlocks(lanes, options.edgesOf)
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
    for (const [lane, events] of lanes) {
      const actor = options.actorFor(lane)
      if (actor !== undefined && !restingActor(actor, events)) return false
    }
    return driver.resting()
  }

  const wake = (lane: string): Promise<void> => {
    driver.mark(lane)
    return drive()
  }

  return { seed, read, commit, commitRoot, drive, wake, resting, router, self }
}
