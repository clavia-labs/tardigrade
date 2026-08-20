import { Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/event-log"
import { Router, type CallResult } from "@clavia/tardigrade-core/router"
import { Self, restingActor, settleActor, type Actor } from "@clavia/tardigrade-core/actor"
import { Facets } from "@clavia/tardigrade-core/facets"
import { deadlocks, victimOf, type EdgesOf } from "./deadlock"

// A host runs the emergent graph: many lanes, one router, one driver.
// This is the default binding: in-process and volatile, semantics only.
// A binding that adds physics (durable storage, real alarms, isolation)
// earns a qualified name and must keep every guarantee here; the
// conformance contract is packages/core/tla (Driver, Delivery).

// HostPorts are the services every host binds per lane: the log, the
// router, this lane's address, and the read over its siblings' logs.
// layersFor may require them and must not provide them.
export type HostPorts = EventLog | Router | Self | Facets

// LaneEnv is the rest of an actor's R: what the host does not bind.
// Construction may require HostPorts; Layer.provideMerge discharges them.
export type LaneEnv<R> = Layer.Layer<Exclude<R, HostPorts>, never, HostPorts>

// Alarm is the platform timer, stated as a projection of one lane's log:
// the instant the lane is next owed a visit, and the fact to append when
// that instant arrives. Undefined is nothing due. The host re-derives the
// answer after every settle and on recovery, so an armed alarm survives a
// death and a lane holds one timer at a time (packages/core/tla/Driver.tla,
// armed and Accounting).
//
// The fact is the owner's, because a reactor may not read the clock: time
// is data on events (packages/core/src/actor.ts, Reactor). The fact must
// name its occurrence in the owner's key table, and the host refuses to arm
// a lane whose log already records that key, because a fact the log
// absorbs would arm the same instant forever (host.test.ts, "an alarm the
// log already records refuses to arm").
export type Alarm = (
  lane: string,
  events: ReadonlyArray<Event>
) => { readonly at: number; readonly event: Event } | undefined

type LayersFor<R> = [Exclude<R, HostPorts>] extends [never]
  ? { readonly layersFor?: (lane: string) => LaneEnv<R> }
  : { readonly layersFor: (lane: string) => LaneEnv<R> }

// HostOptions binds a host to its owner's world. actorFor names a
// lane's reactors; a lane with none is a sink (a registry, a mirror)
// and delivery still lands. layersFor supplies the rest of R; the host
// binds EventLog, Router, and Self. A missing Infer is a type error.
// call and resume are the synchronous doors; a host without them
// refuses synchronous calls with an error result.
export type HostOptions<R> = {
  readonly principal?: string
  readonly actorFor: (lane: string) => Actor<R> | undefined
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
  // alarm arms the platform timer per lane. Absent, no lane is ever woken
  // by time, and a process that owes future work runs its own loop over
  // `wake` instead (Alarm).
  readonly alarm?: Alarm
} & LayersFor<R>

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
  //
  // Drives are serialized and coalesced, so a caller never has to hold a
  // lock of its own: a drive requested while one runs adds exactly one
  // follow-up pass, and both callers await the same promise. The promise
  // resolves once the graph is quiet, so a caller that delivered first is
  // served by a pass that started after its event landed.
  readonly drive: () => Promise<void>
  // recover marks every lane that has an actor as owed a visit, arms the
  // alarms their logs derive, and drives: the pass a process runs at start,
  // so work interrupted by a death settles from the surviving log. Volatile
  // here, so it re-settles what this process still holds; the durable
  // binding re-settles what the store kept (platform/bun/src/host.ts).
  readonly recover: () => Promise<void>
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

export const createHost = <R = never>(options: HostOptions<R>): Host => {
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
      router,
      Layer.succeed(Self, self(lane)),
      // All lanes share one store here, so the observe privilege is the host's own read
      // (packages/core/src/logs.ts, Facets). A lane's own log still arrives as EventLog: this
      // one reads a sibling and cannot append.
      logs
    )

  // Exclude is not distributive over a generic R, so the merge is named
  // here as the env settleActor requires (tla/Driver.tla, EventuallyServed).
  const layersOf = (lane: string): Layer.Layer<R | EventLog> => {
    const extra = (options.layersFor ?? (() => Layer.empty as unknown as LaneEnv<R>))(lane)
    return extra.pipe(Layer.provideMerge(portsOf(lane))) as Layer.Layer<R | EventLog>
  }

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  // The failure of a drive that had no caller, the one an alarm starts. It
  // is raised by the next drive, so the process dies on it rather than
  // driving on over a broken host.
  let failure: unknown = undefined

  // arm holds one timer per lane, re-derived from the lane's own log. A
  // lane with nothing due holds none, so the timer table is a projection
  // like everything else and a stale arm cannot outlive the fact that
  // caused it (tla/Driver.tla, Accounting).
  const arm = (lane: string): void => {
    if (options.alarm === undefined) return
    const held = timers.get(lane)
    if (held !== undefined) {
      clearTimeout(held)
      timers.delete(lane)
    }
    const events = read(lane)
    const due = options.alarm(lane, events)
    if (due === undefined) return
    const key = options.keyOf?.(due.event)
    if (key !== undefined && events.some((e) => options.keyOf?.(e) === key)) {
      throw new Error(
        `alarm for lane "${lane}" names "${due.event.type}" under key "${key}", which the log already records: a fired fact the log absorbs arms the same instant forever`
      )
    }
    const timer = setTimeout(() => {
      timers.delete(lane)
      // The fire is a delivery like any other: the fact lands, the lane is
      // owed a visit, and the same coalescing drive serves it. A drive
      // nobody asked for has no caller to report to, so its failure is held
      // for the next one.
      append(lane, [due.event])
      dirty.add(lane)
      void drive().catch((error: unknown) => {
        failure = error
      })
    }, Math.max(0, due.at - Date.now()))
    // The timer must not hold the process open. What keeps a server alive
    // is its own socket, and a test that leaves a lane armed still exits.
    timer.unref?.()
    timers.set(lane, timer)
  }

  const drain = async (): Promise<void> => {
    while (dirty.size > 0) {
      const lane = options.pick?.(dirty) ?? (dirty.values().next().value as string)
      dirty.delete(lane)
      const actor = options.actorFor(lane)
      if (actor === undefined) continue
      await Effect.runPromise(settleActor(actor).pipe(Effect.provide(layersOf(lane))))
      arm(lane)
    }
  }

  const pass = async (): Promise<void> => {
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

  // The driver runs one pass at a time. A drive requested while one runs
  // coalesces into exactly one follow-up pass, and every caller awaits the
  // same promise, so one lane never settles twice at once however many
  // senders arrive together. This is the binding's discharge of the
  // platform's obligation to serialize sends per actor
  // (packages/core/src/actor.ts, Self; packages/core/src/event-log.ts,
  // guarantee 3). Two request handlers delivering at the same instant is
  // the ordinary shape of an event-driven process, and two settles over one
  // log derive the same transition and run its effect twice
  // (host.test.ts, "concurrent drives settle a lane once").
  let driving: Promise<void> | undefined
  let follow = false
  const pump = async (): Promise<void> => {
    try {
      do {
        follow = false
        await pass()
      } while (follow)
    } finally {
      driving = undefined
      follow = false
    }
  }

  const drive = (): Promise<void> => {
    if (failure !== undefined) {
      const held = failure
      failure = undefined
      return Promise.reject(held)
    }
    if (driving !== undefined) {
      follow = true
      return driving
    }
    driving = pump()
    return driving
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

  const recover = async (): Promise<void> => {
    for (const lane of lanes.keys()) {
      if (options.actorFor(lane) === undefined) continue
      dirty.add(lane)
      arm(lane)
    }
    await drive()
  }

  return { seed, read, deliver, drive, wake, recover, resting, router, self }
}
