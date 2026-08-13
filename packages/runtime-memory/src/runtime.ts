import { Effect, Layer } from "effect"
import {
  EventLog,
  Placement,
  Router,
  Self,
  Sink,
  Spill,
  Wake,
  Writer,
  type DedupKey,
  type Envelope
} from "@flamecast/core"
import { memoryEventLog } from "./event-log"

// The memory runtime: every port bound in one process, with arrays and maps behind them.
//
// It exists so the rest of the framework is testable with no files, no keys, and no cloud account.
// A runtime that binds the same eight ports against a real platform is proved by the same
// conformance kit that proves this one, and that is what portability means here.
//
// One layer serves one session, because a session is the unit of concurrency and the unit of
// storage. Two programs provided the same layer value share one log, which is what makes a crash
// and resume test possible: build the layer, settle, drop the program, settle again.

export interface MemoryOptions {
  // The dedup key policy the store absorbs redeliveries on, and the one required option.
  //
  // Guarantee 5 of the log port is only real once a policy names the key, and the policy belongs to
  // whoever owns the event alphabet: `keyOf` from `@flamecast/harness` for a harness, `dedupKey`
  // from `@flamecast/core` for events that state their own key. It was optional once and defaulted
  // to `dedupKey`, which made a program with the guarantee and a program without it look identical
  // at the call site. Requiring it is the whole point: the shortest path that compiles is the one
  // where a redelivered event lands once.
  readonly keyOf: DedupKey
  // The address of this session. `Self` carries it, and `Wake` reports its owed alarms under it.
  readonly session?: string
  // The events the log starts from. A recorded run seeds the log and a settle resumes it.
  readonly seed?: ReadonlyArray<Envelope>
  // Where the Router sends. A test that needs a sub-agent binds a function; the default runtime has
  // one session and no route, and it says so rather than dropping an event in silence.
  readonly route?: (address: string, event: Envelope) => Effect.Effect<Envelope>
}

export const MemoryRuntime = (options: MemoryOptions) => {
  const session = options.session ?? "memory"
  const log = memoryEventLog(options)

  // The single writer, per session address. A semaphore of one permit is the in-process form of the
  // lease a Postgres advisory lock or an S3 compare-and-swap gives across processes: a second
  // holder waits rather than interleaving. It is built without a suspension point, so two fibers
  // racing for the first hold on one session still share one lease.
  const leases = new Map<string, Effect.Semaphore>()
  const leaseOf = (address: string) => {
    const held = leases.get(address)
    if (held !== undefined) return held
    const fresh = Effect.unsafeMakeSemaphore(1)
    leases.set(address, fresh)
    return fresh
  }

  // The wake table. The runtime arms no real timer: a test drives time itself, and a timer that
  // fired on its own would make a test nondeterministic. `owed` is the table a restart re-arms from.
  let armed: number | undefined

  const blobs = new Map<string, Uint8Array>()
  let spilled = 0

  const routed = (address: string, event: Envelope) =>
    Effect.suspend(() =>
      options.route?.(address, event) ??
        Effect.die(new Error(`memory runtime: no route to "${address}" for "${event.type}"`))
    )

  return Layer.mergeAll(
    Layer.succeed(EventLog, log),
    Layer.succeed(Writer, {
      hold: (address, work) => leaseOf(address).withPermits(1)(work)
    }),
    Layer.succeed(Wake, {
      armIfSooner: (at) =>
        Effect.sync(() => {
          if (armed === undefined || at < armed) armed = at
        }),
      owed: Effect.sync(() => (armed === undefined ? [] : [{ session, at: armed }]))
    }),
    Layer.succeed(Placement, { home: () => Effect.succeed(session) }),
    Layer.succeed(Spill, {
      // The reference counts up rather than hashing or randomizing, so the same run spills to the
      // same references twice and a replay reads what the recorded event points at.
      put: (value) =>
        Effect.sync(() => {
          spilled += 1
          const ref = `spill:${spilled}`
          blobs.set(ref, value)
          return ref
        }),
      get: (ref) =>
        Effect.suspend(() => {
          const value = blobs.get(ref)
          return value === undefined
            ? Effect.die(new Error(`memory runtime: no spilled value at "${ref}"`))
            : Effect.succeed(value)
        })
    }),
    // Telemetry is optional and the stored log is complete without it, so the memory sink
    // drops what it is given.
    Layer.succeed(Sink, { write: () => Effect.void }),
    Layer.succeed(Router, {
      deliver: (address, event) => Effect.asVoid(routed(address, event)),
      call: routed
    }),
    Layer.succeed(Self, session)
  )
}
