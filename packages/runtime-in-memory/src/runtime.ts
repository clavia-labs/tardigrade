import { Context, Effect, Layer, Semaphore } from "effect"
import {
  EventLog,
  Placement,
  Router,
  Self,
  Sessions,
  Sink,
  Spill,
  Wake,
  Writer,
  type DedupKey,
  type Event,
  type EventLogStore
} from "@flamecast/core"
import { inMemoryEventLog } from "./event-log"

// The complete process-local runtime: every port is bound with arrays, maps, and a semaphore.
// Its state remains available for the lifetime of the layer and requires no external services.
// Durable runtimes preserve the same contracts across processes and restarts.
//
// The runtime serves one session or many. A session is one address, one log, and one writer lease,
// and the `sessions` registry names what answers at which address. Storage and the lease appear on
// first delivery, so an address that is never used costs nothing, and an address a caller invents
// becomes a session the moment a registry pattern claims it.
//
// This is the seam a durable binding replaces. There an address already names a durable object or a
// cell, and the platform owns resolution, storage, and the lease. Nothing above these ports changes.

// What answers at an address: an event goes in, the terminal event comes out. `serve` in the
// harness turns an agent into one of these, and an application whose sessions are machines rather
// than agents writes its own function of the same shape.
export type Serve = (event: Event) => Effect.Effect<Event, never, any>

// Who answers where. An exact key names one address and holds what serves it. A `prefix/*` key, or
// a bare `*`, names a family and holds a factory that receives the address, so the key's shape says
// which is which and no marker is needed. The most specific key wins.
export type SessionRegistry = Readonly<Record<string, Serve | ((address: string) => Serve)>>

export interface InMemoryOptions<R = never> {
  // The dedup key policy the store absorbs redeliveries on, and the one required option.
  //
  // Guarantee 5 of the log port is only real once a policy names the key, and the policy belongs to
  // whoever owns the event alphabet: `keyOf` from `@flamecast/harness` for a harness, `dedupKey`
  // from `@flamecast/core` for events that state their own key. It was optional once and defaulted
  // to `dedupKey`, which made an agent with the guarantee and an agent without it look identical at
  // the call site. Requiring it is the whole point: the shortest path that compiles is the one
  // where a redelivered event lands once.
  readonly keyOf: DedupKey
  // The address a caller runs in directly. `Self` carries it, `seed` fills its log, and `Wake`
  // reports its owed alarms under it.
  readonly session?: string
  // The events the primary session starts from. A recorded run seeds the log and a settle resumes it.
  readonly seed?: ReadonlyArray<Event>
  readonly sessions?: SessionRegistry
  // What the sessions require beyond the runtime's own ports, such as a sandbox. The runtime binds
  // these for a served session and for a caller alike, so one declaration covers both.
  readonly services?: Context.Context<R>
}

export const InMemoryRuntime = <R = never>(options: InMemoryOptions<R>) => {
  const session = options.session ?? "in-memory"
  const registry = options.sessions ?? {}
  const services = options.services ?? (Context.empty() as Context.Context<R>)

  // One store per address. The primary session is seeded, and every other address starts empty.
  const stores = new Map<string, EventLogStore>([
    [
      session,
      inMemoryEventLog({
        keyOf: options.keyOf,
        ...(options.seed === undefined ? {} : { seed: options.seed })
      })
    ]
  ])
  const storeOf = (address: string) => {
    const held = stores.get(address)
    if (held !== undefined) return held
    const fresh = inMemoryEventLog({ keyOf: options.keyOf })
    stores.set(address, fresh)
    return fresh
  }

  // The single writer, per session address. A semaphore of one permit is the in-process form of the
  // lease a Postgres advisory lock or an S3 compare-and-swap gives across processes: a second
  // holder waits rather than interleaving. It is built without a suspension point, so two fibers
  // racing for the first hold on one session still share one lease.
  //
  // Routing does not take the lease. Whatever serves the address takes it through this port, and a
  // second hold on one address from the same fiber would wait on itself.
  const leases = new Map<string, Semaphore.Semaphore>()
  const leaseOf = (address: string) => {
    const held = leases.get(address)
    if (held !== undefined) return held
    const fresh = Semaphore.makeUnsafe(1)
    leases.set(address, fresh)
    return fresh
  }

  // The wake table. The runtime arms no real timer: a test drives time itself, and a timer that
  // fired on its own would make a test nondeterministic. `owed` is the table a restart re-arms from.
  let armed: number | undefined

  const blobs = new Map<string, Uint8Array>()
  let spilled = 0

  // The resolved behavior for an address, memoized, so a factory runs once per address and a
  // session keeps one behavior for its lifetime. The exact lookup asks for an own property, because
  // a plain object inherits `constructor` and `toString` and a caller can choose the address.
  const served = new Map<string, Serve>()
  const serveOf = (address: string): Serve | undefined => {
    const built = served.get(address)
    if (built !== undefined) return built
    if (Object.hasOwn(registry, address)) {
      const exact = registry[address] as Serve
      served.set(address, exact)
      return exact
    }
    const pattern = Object.entries(registry)
      .filter(([key]) => (key === "*" || key.endsWith("/*")) && address.startsWith(key.slice(0, -1)))
      .sort(([a], [b]) => b.length - a.length)[0]
    if (pattern === undefined) return undefined
    const resolved = (pattern[1] as (address: string) => Serve)(address)
    served.set(address, resolved)
    return resolved
  }

  const writer = {
    hold: <A, E, Rw>(address: string, work: Effect.Effect<A, E, Rw>) =>
      leaseOf(address).withPermits(1)(work)
  }

  const wake = {
    armIfSooner: (at: number) =>
      Effect.sync(() => {
        if (armed === undefined || at < armed) armed = at
      }),
    owed: Effect.sync(() => (armed === undefined ? [] : [{ session, at: armed }]))
  }

  const placement = { home: () => Effect.succeed(session) }

  const spill = {
    // The reference counts up rather than hashing or randomizing, so the same run spills to the
    // same references twice and a replay reads what the recorded event points at.
    put: (value: Uint8Array) =>
      Effect.sync(() => {
        spilled += 1
        const ref = `spill:${spilled}`
        blobs.set(ref, value)
        return ref
      }),
    get: (ref: string) =>
      Effect.suspend(() => {
        const value = blobs.get(ref)
        return value === undefined
          ? Effect.die(new Error(`in-memory runtime: no spilled value at "${ref}"`))
          : Effect.succeed(value)
      })
  }

  // Telemetry is optional and the stored log is complete without it, so the in-memory sink drops
  // what it is given.
  const sink = { write: () => Effect.void }

  // A session exists once its log holds something. Routing to an address materializes a store
  // before whatever serves it decides what to do, and a delivery that is refused appends nothing,
  // so an empty log is an address that was reached and never recorded anything. State is the fold
  // of the log, and an empty log folds to nothing, so it is not a session yet.
  const sessions = {
    list: Effect.gen(function* () {
      const held: Array<string> = []
      for (const [address, store] of stores) {
        if ((yield* store.head) > 0) held.push(address)
      }
      return held as ReadonlyArray<string>
    }),
    // Reading an address the runtime never held is an empty history, and asking does not create one.
    read: (address: string) =>
      stores.get(address)?.read ?? Effect.succeed([] as ReadonlyArray<Event>)
  }

  // A delivery to an address: find what serves it, then run it under that session's log and name.
  // Every other port is shared, so a routed session reaches the same router and can delegate on.
  const routed = (address: string, event: Event): Effect.Effect<Event> =>
    Effect.suspend(() => {
      const serve = serveOf(address)
      if (serve === undefined) {
        return Effect.succeed({
          type: "TurnFailed",
          turn: String(event.id ?? ""),
          error: `no session serves "${address}"`
        })
      }
      return serve(event).pipe(
        Effect.provideService(EventLog, storeOf(address)),
        Effect.provideService(Self, address),
        Effect.provideService(Writer, writer),
        Effect.provideService(Wake, wake),
        Effect.provideService(Placement, placement),
        Effect.provideService(Spill, spill),
        Effect.provideService(Sink, sink),
        Effect.provideService(Router, router),
        Effect.provideService(Sessions, sessions),
        Effect.provideContext(services)
      ) as Effect.Effect<Event>
    })

  const router = {
    deliver: (address: string, event: Event) => Effect.asVoid(routed(address, event)),
    call: routed
  }

  return Layer.mergeAll(
    Layer.succeedContext(services),
    Layer.succeed(EventLog, storeOf(session)),
    Layer.succeed(Writer, writer),
    Layer.succeed(Wake, wake),
    Layer.succeed(Placement, placement),
    Layer.succeed(Spill, spill),
    Layer.succeed(Sink, sink),
    Layer.succeed(Router, router),
    Layer.succeed(Sessions, sessions),
    Layer.succeed(Self, session)
  )
}
