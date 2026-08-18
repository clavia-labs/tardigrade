import { Effect, Layer } from "effect"
import type { Event } from "@tardigrade/core/event"
import { EventLog, withWatermark } from "@tardigrade/core/event-log"
import { Router, type CallResult } from "@tardigrade/core/router"
import { Self, restingActor, settleActor, type Actor } from "@tardigrade/core/actor"
import { deadlocks, victimOf, type EdgesOf } from "./deadlock"

// A host runs the emergent graph: many lanes, one router, one driver.
// This is the default binding: in-process and volatile, semantics only.
// A binding that adds physics (durable storage, real alarms, isolation)
// earns a qualified name and must keep every guarantee here; the
// conformance contract is packages/core/tla (Driver, Delivery).

// HostOptions binds a host to its owner's world. actorFor names a
// lane's reactors; a lane with none is a sink (a registry, a mirror)
// and delivery still lands. layersFor supplies the lane's environment
// beyond what the host provides (EventLog, Router, Self); packages and
// inference live there. call and resume are the synchronous doors; a
// host without them refuses synchronous calls with an error result.
export interface HostOptions<R> {
  readonly principal?: string
  readonly actorFor: (lane: string) => Actor<R> | undefined
  readonly layersFor?: (lane: string) => Layer.Layer<unknown, never, EventLog | Router | Self>
  readonly call?: Parameters<typeof Router.of>[0]["call"]
  readonly resume?: Parameters<typeof Router.of>[0]["resume"]
  // edgesOf arms the deadlock sentinel: after a drive drains, the host
  // breaks each await cycle among resting lanes by failing one victim
  // edge with a synthetic error reply, then drives on. Without it a
  // cycle rests forever (packages/core/tla/Delivery.tla,
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
}

export interface Host {
  // seed appends without waking the lane: test and bootstrap ingress.
  readonly seed: (lane: string, events: ReadonlyArray<Event>) => void
  readonly read: (lane: string) => ReadonlyArray<Event>
  // deliver is the router's contract: at-least-once, receiver dedup by
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

const REFUSED: CallResult = { error: "this host takes no synchronous calls" }

export const createHost = <R>(options: HostOptions<R>): Host => {
  const principal = options.principal ?? "mem"
  const lanes = new Map<string, ReadonlyArray<Event>>()
  const dirty = new Set<string>()

  const read = (lane: string): ReadonlyArray<Event> => lanes.get(lane) ?? []
  // append implements guarantee 5 of the log port (packages/core/src/event-log.ts): a keyed
  // redelivery is absorbed. With keys deciding commitment (Actor.keyOf), the library tier
  // must keep the platform store's promise, or a re-parked attempt's BlockedOn lands twice
  // here and once there.
  const append = (lane: string, events: ReadonlyArray<Event>): void => {
    const current = read(lane)
    if (options.keyOf === undefined) {
      lanes.set(lane, [...current, ...events])
      return
    }
    const recorded = new Set<string>()
    for (const e of current) {
      const key = options.keyOf(e)
      if (key !== undefined) recorded.add(key)
    }
    const landing: Event[] = []
    for (const e of events) {
      const key = options.keyOf(e)
      if (key !== undefined) {
        if (recorded.has(key)) continue
        recorded.add(key)
      }
      landing.push(e)
    }
    lanes.set(lane, [...current, ...landing])
  }
  const seed = (lane: string, events: ReadonlyArray<Event>): void => append(lane, events)

  const deliver = (address: string, event: Event): void => {
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
    if (seen(read(lane), event)) return
    append(lane, [event])
    dirty.add(lane)
  }

  const router = Layer.succeed(Router, {
    deliver: (address: string, event: Event) => Effect.sync(() => deliver(address, event)),
    call: options.call ?? (() => Effect.succeed(REFUSED)),
    resume: options.resume ?? (() => Effect.succeed(REFUSED))
  })

  const self = (lane: string): string => `${principal}:${lane}`

  const layersOf = (lane: string) =>
    Layer.mergeAll(
      Layer.succeed(
        EventLog,
        withWatermark({
          append: (events: ReadonlyArray<Event>) => Effect.sync(() => append(lane, events)),
          read: Effect.sync(() => read(lane))
        })
      ),
      router,
      Layer.succeed(Self, self(lane)),
      options.layersFor?.(lane) ?? Layer.empty
    )

  const drain = async (): Promise<void> => {
    while (dirty.size > 0) {
      const lane = options.pick?.(dirty) ?? (dirty.values().next().value as string)
      dirty.delete(lane)
      const actor = options.actorFor(lane)
      if (actor === undefined) continue
      await Effect.runPromise(
        settleActor(actor).pipe(Effect.provide(layersOf(lane))) as Effect.Effect<void>
      )
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
        deliver(victim.from, {
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

  return { seed, read, deliver, drive, wake, resting, router, self }
}
