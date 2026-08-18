import { Clock, Context, Duration, Effect, Fiber, Layer, Semaphore } from "effect"
import {
  Alarm,
  EventLog,
  Router,
  Self,
  Sessions,
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
//
// `R` is what the answering session needs beyond the runtime's own ports. It rides the type rather
// than being erased, so a session that reaches for a service the runtime was not given fails to
// compile instead of dying on its first delivery.
export type Serve<R = never> = (
  event: Event
) => Effect.Effect<Event, never, SessionPorts | R>

// The ports the runtime binds for every session it serves. A serve function may reach any of them
// without declaring anything, because the runtime owes them all.
export type SessionPorts =
  | EventLog
  | Writer
  | Router
  | Sessions
  | Self
  | Alarm

// What a family of addresses answers with: the address goes in, and what serves it comes out.
export type SessionFactory<R = never> = (address: string) => Serve<R>

// Who answers where. An exact key names one address and holds what serves it. A `prefix/*` key, or
// a bare `*`, names a family and holds a factory that receives the address. The most specific key
// wins.
export type SessionRegistry<R = never> = Readonly<
  Record<string, Serve<R> | SessionFactory<R>>
>

// The registry as the caller wrote it, checked key by key. Both halves are one-argument functions,
// so nothing but the key's shape can say which one a value is meant to be, and a union would let
// either mistake compile: a factory at an exact key is called with the event as its address, and a
// serve at a pattern key is called with the address as its event. Both die on delivery. The mapped
// type reads the key and demands the matching half.
export type ValidRegistry<Keys, R> = {
  readonly [Key in keyof Keys]: Key extends `${string}/*` | "*" ? SessionFactory<R> : Serve<R>
}

export interface InMemoryOptions<R = never, Keys = Readonly<Record<string, never>>> {
  // The dedup key policy the store absorbs redeliveries on, and the one required option.
  //
  // Guarantee 5 of the log port is only real once a policy names the key, and the policy belongs to
  // whoever owns the event alphabet: `keyOf` from `@flamecast/harness` for a harness, `dedupKey`
  // from `@flamecast/core` for events that state their own key. It was optional once and defaulted
  // to `dedupKey`, which made an agent with the guarantee and an agent without it look identical at
  // the call site. Requiring it is the whole point: the shortest path that compiles is the one
  // where a redelivered event lands once.
  readonly keyOf: DedupKey
  // The address a caller runs in directly. `Self` carries it and `seed` fills its log.
  readonly session?: string
  // The events the primary session starts from. A recorded run seeds the log and a settle resumes it.
  readonly seed?: ReadonlyArray<Event>
  readonly sessions?: ValidRegistry<Keys, R>
  // What the sessions require beyond the runtime's own ports, such as a sandbox. The runtime binds
  // these for a served session and for a caller alike, so one declaration covers both.
  readonly services?: Context.Context<R>
}

export const InMemoryRuntime = <R = never, const Keys = Readonly<Record<string, never>>>(
  options: InMemoryOptions<R, Keys>
) => {
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

  // The resolved behavior for an address, memoized, so a factory runs once per address and a
  // session keeps one behavior for its lifetime. The exact lookup asks for an own property, because
  // a plain object inherits `constructor` and `toString` and a caller can choose the address.
  // The registry is typed key by key for the caller. Inside, it is read as the plain record it is.
  const entries = registry as SessionRegistry<R>
  const served = new Map<string, Serve<R>>()
  const serveOf = (address: string): Serve<R> | undefined => {
    const built = served.get(address)
    if (built !== undefined) return built
    if (Object.hasOwn(entries, address)) {
      const exact = entries[address] as Serve<R>
      served.set(address, exact)
      return exact
    }
    const pattern = Object.entries(entries)
      .filter(([key]) => (key === "*" || key.endsWith("/*")) && address.startsWith(key.slice(0, -1)))
      .sort(([a], [b]) => b.length - a.length)[0]
    if (pattern === undefined) return undefined
    // A factory owes a function. A registry written by hand can not get this wrong, because the
    // key's shape types the value, but a generated one meets no compiler, and returning the wrong
    // half here would surface as an unreadable defect one call later.
    const resolved = (pattern[1] as SessionFactory<R>)(address)
    if (typeof resolved !== "function") {
      throw new Error(
        `the registry key "${pattern[0]}" names a family, so it owes a function of the address, and it returned ${typeof resolved}`
      )
    }
    served.set(address, resolved)
    return resolved
  }

  const writer = {
    hold: <A, E, Rw>(address: string, work: Effect.Effect<A, E, Rw>) =>
      leaseOf(address).withPermits(1)(work)
  }

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
      const answering = serve(event)
      // The mirror of the factory check: an exact key that holds a factory answers with another
      // function rather than with the effect of a turn.
      if (typeof answering === "function") {
        throw new Error(
          `the registry key "${address}" names one address, so it owes what serves it, and it answered with a function of the address`
        )
      }
      return answering.pipe(
        Effect.provideService(EventLog, storeOf(address)),
        Effect.provideService(Self, address),
        Effect.provideService(Writer, writer),
        Effect.provideService(Router, router),
        Effect.provideService(Sessions, sessions),
        Effect.provideService(Alarm, alarm),
        Effect.provideContext(services)
      ) as Effect.Effect<Event>
    })

  const router = {
    deliver: (address: string, event: Event) => Effect.asVoid(routed(address, event)),
    call: routed
  }

  // One due wake per session. A later `set` interrupts the earlier timer, which is the in-process
  // form of Durable Object storage holding a single alarm. The timer is a detached fiber so a turn
  // that has already returned still wakes. Delivery goes through whatever serves the address, so a
  // session reached only by `agent.turn` is woken by replaying the wake event.
  const alarms = new Map<string, Fiber.Fiber<unknown, never>>()
  const alarm = {
    set: (address: string, at: number, event: Event) =>
      Effect.gen(function* () {
        const prior = alarms.get(address)
        if (prior !== undefined) {
          yield* Fiber.interrupt(prior)
          alarms.delete(address)
        }
        if (serveOf(address) === undefined) return
        const fiber = yield* Effect.forkDetach(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            if (at > now) yield* Effect.sleep(Duration.millis(at - now))
            yield* routed(address, event)
          })
        )
        alarms.set(address, fiber)
      })
  }

  return Layer.mergeAll(
    Layer.succeedContext(services),
    Layer.succeed(EventLog, storeOf(session)),
    Layer.succeed(Writer, writer),
    Layer.succeed(Router, router),
    Layer.succeed(Sessions, sessions),
    Layer.succeed(Self, session),
    Layer.succeed(Alarm, alarm)
  )
}
