import { Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/event-log"
import { Transport, type CallResult } from "@clavia/tardigrade-core/communication/transport"
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
import { deadlocks, victimOf, type EdgesOf } from "./deadlock"
import { outboundFrom, type Provider } from "./communication/provider"
import {
  sameActorAddress,
  sameThreadLineage,
  threadCreated,
  threadCreatedOf,
  threadKeys,
  type ThreadLineage
} from "@clavia/tardigrade-core/thread"

// A host runs the emergent graph: many lanes, one transport, one driver.
// This is the default binding: in-process and volatile, semantics only.
// A binding that adds physics (durable storage, real alarms, isolation)
// earns a qualified name and must keep every guarantee here; the
// conformance contract is packages/core/tla/runtime/Driver.tla and packages/core/tla/communication/Delivery.tla.

// HostPorts are the services every host binds per lane: the log, the
// transport, this lane's address, and the read over its siblings' logs.
// layersFor may require them and must not provide them.
export type HostPorts = EventLog | Transport | Self | Facets

// LaneEnv is the rest of an actor's R: what the host does not bind.
// Construction may require HostPorts; Layer.provideMerge discharges them.
export type LaneEnv<R> = Layer.Layer<Exclude<R, HostPorts>, never, HostPorts>

type LayersFor<R> = [Exclude<R, HostPorts>] extends [never]
  ? { readonly layersFor?: (lane: string) => LaneEnv<R> }
  : { readonly layersFor: (lane: string) => LaneEnv<R> }

// HostOptions binds a host to its owner's world. actorFor names a
// lane's reactors; a lane with none is a sink (a registry, a mirror)
// and delivery still lands. layersFor supplies the rest of R; the host
// binds EventLog, Transport, and Self. A missing Infer is a type error.
// call and resume are the synchronous doors; a host without them
// refuses synchronous calls with an error result.
export type HostOptions<R> = {
  readonly principal?: string
  readonly actorFor: (lane: string) => Actor<R> | undefined
  readonly call?: Parameters<typeof Transport.of>[0]["call"]
  readonly resume?: Parameters<typeof Transport.of>[0]["resume"]
  readonly providers?: ReadonlyArray<Provider>
  // edgesOf arms the deadlock sentinel: after a drive drains, the host
  // breaks each await cycle among resting lanes by failing one victim
  // edge with a synthetic error reply, then drives on. Without it a
  // cycle rests forever (packages/core/tla/communication/Delivery.tla,
  // DeliveryDeadlock).
  readonly edgesOf?: EdgesOf
  // pick chooses which dirty lane the driver serves next; the default
  // is insertion order. Service order must not change any outcome: the
  // confluence property test shuffles this seam.
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
  // accept commits one addressed delivery, including child creation lineage when present.
  readonly accept: (delivery: Delivery<unknown, Event, ActorAddress>) => void
  // deliver is the transport's contract: at-least-once, receiver dedup by
  // message id, and the lane is marked owed a visit.
  readonly deliver: (address: string, event: Event) => void
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
  // transport is the host's transport as a Layer, for environments built
  // outside layersFor.
  readonly transport: Layer.Layer<Transport>
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

const isOutboundLink = (
  link: Link<ActorAddress, ActorAddress> | Link<ActorAddress, ProviderAddress>
): link is Link<ActorAddress, ProviderAddress> => isProviderAddress(link.target)

const REFUSED: CallResult = { error: "this host takes no synchronous calls" }

export const createHost = <R = never>(options: HostOptions<R>): Host => {
  const principal = options.principal ?? "mem"
  const lanes = new Map<string, ReadonlyArray<Event>>()
  const dirty = new Set<string>()
  const outbound = outboundFrom(options.providers ?? [])
  const storeKeyOf = (event: Event): string | undefined => threadKeys.keyOf(event) ?? options.keyOf?.(event)

  const read = (lane: string): ReadonlyArray<Event> => lanes.get(lane) ?? []
  // append implements guarantee 5 of the log port (packages/core/src/event-log.ts): a keyed
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

  const commit = (
    target: ActorAddress,
    event: Event,
    lineage: ThreadLineage | undefined,
    link?: Link<unknown, ActorAddress>
  ): void => {
    const address = formatActorAddress(target)
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
    if (created !== undefined && !sameActorAddress(created.address, target)) {
      throw new Error(`thread ${address} creation address does not match its target`)
    }
    if (lineage !== undefined) {
      if (lineage.depth <= 0 || sameActorAddress(lineage.parent, target)) {
        throw new Error(`thread ${address} has invalid child lineage`)
      }
      if (link === undefined || !isActorAddress(link.source) || !sameActorAddress(lineage.parent, link.source)) {
        throw new Error(`thread ${address} lineage parent does not match its delivery source`)
      }
      if (created !== undefined && !sameThreadLineage(created, lineage)) {
        throw new Error(`thread ${address} already has different lineage`)
      }
    } else if (created === undefined && link !== undefined && isActorAddress(link.source)) {
      throw new Error(`initial actor delivery to ${address} must carry lineage`)
    }
    const landed = link !== undefined && event.type === "MessageReceived"
      ? linkedEventOf({ link, event })
      : event
    if (seen(current, landed)) return
    append(lane, created === undefined ? [threadCreated(target, lineage, eventAt(event)), landed] : [landed])
    dirty.add(lane)
  }

  const accept = (delivery: Delivery<unknown, Event, ActorAddress>): void =>
    commit(delivery.link.target, delivery.event, delivery.lineage, delivery.link)

  const deliver = (address: string, event: Event): void =>
    commit(parseActorAddress(address), event, undefined)

  const transport = Layer.succeed(Transport, {
    deliver: (delivery) =>
      isOutboundLink(delivery.link)
        ? outbound.send(
            delivery.link,
            delivery.event as import("@clavia/tardigrade-core/communication/message").MessageReceived
          )
        : Effect.sync(() => accept(delivery as Delivery<ActorAddress, Event, ActorAddress>)),
    call: options.call ?? (() => Effect.succeed(REFUSED)),
    resume: options.resume ?? (() => Effect.succeed(REFUSED))
  })

  const logs = Layer.succeed(Facets, { read: (name: string) => Effect.sync(() => read(name)) })

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
      transport,
      Layer.succeed(Self, parseActorAddress(self(lane))),
      // All lanes share one store here, so the observe privilege is the host's own read
      // (packages/core/src/logs.ts, Facets). A lane's own log still arrives as EventLog: this
      // one reads a sibling and cannot append.
      logs
    )

  // Exclude is not distributive over a generic R, so the merge is named
  // here as the env settleActor requires (tla/runtime/Driver.tla, EventuallyServed).
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
      await Effect.runPromise(settleActor(actor).pipe(Effect.provide(layersOf(lane))))
    }
  }

  const drive = async (): Promise<void> => {
    await drain()
    if (options.edgesOf === undefined) return
    // A quiet graph may still be knotted: the sentinel fails one
    // victim per cycle and drives the fallout until no cycles remain.
    for (;;) {
      const found = deadlocks(lanes, options.edgesOf)
      if (found.length === 0) return
      for (const knot of found) {
        const victim = victimOf(knot)
        deliver(self(victim.from), {
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

  const resting = (): boolean => {
    for (const [lane, events] of lanes) {
      const actor = options.actorFor(lane)
      if (actor !== undefined && !restingActor(actor, events)) return false
    }
    return dirty.size === 0
  }

  const wake = (lane: string): Promise<void> => {
    dirty.add(lane)
    return drive()
  }

  return { seed, read, accept, deliver, drive, wake, resting, transport, self }
}
