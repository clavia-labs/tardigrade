import { Clock, Effect } from "effect"
import { EventLog } from "./event-log"
import type { Event } from "./event"

// The machine: the core primitive. A consumer defines its domain events, its transitions, and what
// each active state does; the core folds the log into a state and discharges that state's slot.
// State is never stored. It is a fold of the log, so replay is re-folding and recovery is
// re-settling.
//
// The vocabulary, by provenance: the FOLD reads the log into a state name (pure, total, tolerant).
// A DECIDE reads the log into new events (pure given the log and a timestamp). An ACT brings the
// world in: it runs an effect and returns the events that record the outcome, which the log
// commits once. Every state holds at most one of decide or act.
//
// A state with a `decide` or an `act` is an ACTIVE state: the runtime runs the slot and appends the
// events it returns. A state with neither is a RESTING state, and resting is quiescence. An active
// state's emissions must include an event its state transitions on; the runtime dies on a wedge
// instead of looping. A crash between the slot's run and the append re-runs the slot on the next
// settle: delivery is at-least-once, so acts declare idempotent intents and decides re-derive the
// same events. Committed events bind; the tail is free.

// A transition on an event type. The bare form goes to `target`. The guarded form goes to `target`
// only when `when` holds. `when` is the fold's predicate: a PURE, total, synchronous function of
// the log up to and including the event that triggered it. Purity is load-bearing, not stylistic.
// The fold runs on every settle AND every replay, so a guard that read the clock or a random source
// would fold to a different state on replay, and replay-is-refold is the invariant the whole system
// rests on. `when` takes a plain array and returns a boolean, never an `Effect`, so it structurally
// can not reach a service, the log writer, or the model. It must also avoid `Date.now`,
// `Math.random`, and any other ambient nondeterminism; the conformance kit enforces that across
// every machine a harness registers. All nondeterminism lives in acts, whose outputs the log
// commits once.
// `assign` is the fold's memory: when the transition fires, it folds the triggering event into the
// machine's context, the data the fold carries alongside the state name. Like `when`, it is PURE
// and total: context is never stored, it is rebuilt by re-folding, so an assign that read the clock
// or a random source would rebuild a different context on replay. Absent, the transition keeps the
// context as it is.
//
// The context type defaults to `never` rather than `unknown` across the machine types. A machine
// that carries no context has to sit in the same array as its siblings, and `Machine<R, unknown>`
// is not assignable to `Machine<R, never>` because context is invariant. Defaulting to `never` lets
// a plain machine join an agent's list directly, and keeps `erase` for the machines that really do
// carry a context.
export type Transition<C = never> =
  | string
  | {
      readonly target: string
      readonly when?: (log: ReadonlyArray<Event>) => boolean
      readonly assign?: (context: C, event: Event) => C
    }

export interface StateDef<R, C = never> {
  // Derive new events from the record. A decide is pure: the log, `now`, and the folded context
  // fully determine its output, so a re-run after a crash rewrites the same events. `now` is the
  // one clock read, taken by the runtime, so the decide itself stays a plain function the
  // conformance kit can call twice and compare. Appending is the runtime's job, so a decide's only
  // way onto the record is its return value.
  readonly decide?: (
    log: ReadonlyArray<Event>,
    now: number,
    context: C
  ) => ReadonlyArray<Event>
  // Do something in the world, then record it. The act is where all nondeterminism lives: the
  // model, the sandbox, the network. It reads time through Effect's Clock, never `Date.now`. Its
  // returned events are the committed outcome; a re-run re-does the work, which is why acts declare
  // idempotent intents.
  readonly act?: (
    log: ReadonlyArray<Event>,
    context: C
  ) => Effect.Effect<ReadonlyArray<Event>, never, R>
  // When event X, go to state T. A guarded transition only fires when its `when` holds, so a state
  // can stay resting and silent until a computed threshold over the log trips. Unknown event types
  // fall through: tolerant reads.
  readonly on?: Readonly<Record<string, Transition<C>>>
}

export interface Machine<R = never, C = never> {
  // The machine's stable name, used by conformance failures and program observations.
  readonly id: string
  readonly initial: string
  readonly states: Readonly<Record<string, StateDef<R, C>>>
  // The context an empty view folds to. Context is private to the machine: machines compose over
  // event names on the shared log, never over each other's context.
  readonly context?: C
  // The log view the states fold over. Absent, the machine folds the whole log. A machine that
  // serves one turn at a time declares the current turn's slice here; an empty view folds to
  // `initial`, and that is quiescence. Decides and acts always receive the whole log.
  readonly view?: (log: ReadonlyArray<Event>) => ReadonlyArray<Event>
}

// The result of a fold: where the machine sits, and what its transitions remembered on the way.
export interface Fold<C> {
  readonly name: string
  readonly context: C
}

// Context erasure, the one deliberate cast. A machine's context type is invariant (it sits in both
// parameter and return positions), so no honest supertype exists and a heterogeneous machine array
// can not be typed directly. `erase` forgets a machine's context at the actor boundary. It is sound
// in use because the runtime only ever feeds a machine the context its own fold produced: `settle`
// folds m's log through m's transitions and hands the result to m's slots, so machine and context
// can not mismatch. The service type R survives, because the compiler still owes the caller a
// layer that binds it.
export const erase = <R, C>(m: Machine<R, C>): Machine<R, never> => m as unknown as Machine<R, never>

// The constructor checks the one structural rule: a state decides or acts, never both. Throwing at
// definition time is honest about the bug; the machine is malformed before any log exists.
export const machine = <R = never, C = never>(definition: Machine<R, C>): Machine<R, C> => {
  for (const [name, state] of Object.entries(definition.states)) {
    if (state.decide !== undefined && state.act !== undefined) {
      throw new Error(
        `machine "${definition.id}" malformed: the state "${name}" defines both decide and act`
      )
    }
  }
  return definition
}

const viewOf = <R, C>(m: Machine<R, C>, log: ReadonlyArray<Event>) => m.view?.(log) ?? log

// One step of the fold: apply the event at `index` to the state the machine is in. The guard reads
// the view up to and including its own event, so a state can count or threshold over the past
// without leaving the fold. An event the current state has no transition for changes nothing, which
// is the tolerant read at the machine level.
//
// The step is exported because the conformance kit walks every prefix of a log. Re-folding
// each prefix from the start is quadratic on a long log, and a stored log is long.
export const foldStep = <R, C>(
  m: Machine<R, C>,
  at: Fold<C>,
  view: ReadonlyArray<Event>,
  index: number
): Fold<C> => {
  const event = view[index]
  if (event === undefined) return at
  const rule = m.states[at.name]?.on?.[event.type]
  if (rule === undefined) return at
  if (typeof rule === "string") return { name: rule, context: at.context }
  if (rule.when !== undefined && !rule.when(view.slice(0, index + 1))) return at
  return {
    name: rule.target,
    context: rule.assign === undefined ? at.context : rule.assign(at.context, event)
  }
}

// The fold: replay every event of the machine's view through the transitions, into a state name and
// the context the firing transitions assigned along the way. It is pure, total, and tolerant, so
// replay re-folds to the same state.
//
// `m.context as C` is the second deliberate cast. A machine that declares a context type states its
// zero value in `context`; a machine that declares none folds `undefined`, which is the only
// inhabitant its states can read.
const fold = <R, C>(m: Machine<R, C>, view: ReadonlyArray<Event>): Fold<C> => {
  let at: Fold<C> = { name: m.initial, context: m.context as C }
  for (let index = 0; index < view.length; index++) at = foldStep(m, at, view, index)
  return at
}

// The whole fold result: the state name plus the machine's private context. Context is rebuilt from
// the log on every call and never stored, so replay and recovery rebuild it the same way.
export const foldOf = <R, C>(m: Machine<R, C>, log: ReadonlyArray<Event>): Fold<C> =>
  fold(m, viewOf(m, log))

export const stateOf = <R, C>(m: Machine<R, C>, log: ReadonlyArray<Event>) => foldOf(m, log).name

// A view's incarnation: its head's identity. A viewed machine re-entering the same state name under
// a new head is the next instance starting, never a wedge.
const incarnationOf = (view: ReadonlyArray<Event>): string => {
  const head = view[0]
  if (head === undefined) return ""
  return String(head.id ?? head.runId ?? "")
}

// The runtime loop: fold, discharge the active state's decide or act, append, re-fold. Stops at a
// resting state. Dies on a wedge: a slot that emits nothing, or emissions that leave the machine in
// the same active state, would loop forever, and a defect is honest about the bug.
//
// The log is materialized once and then extended by the tail each append lands. The store sees one
// full read plus one watermark read per commit rather than a full read per loop pass, which is what
// keeps a network-backed log affordable. Reading the tail rather than trusting the emission is what
// keeps the fold honest when the store absorbs a redelivered event.
export const settle = <R, C>(m: Machine<R, C>): Effect.Effect<void, never, EventLog | R> =>
  Effect.gen(function* () {
    const store = yield* EventLog
    let log = yield* store.read
    let seq = yield* store.head
    while (true) {
      const seen = viewOf(m, log)
      const { name, context } = fold(m, seen)
      const definition = m.states[name]
      const slot = definition?.decide !== undefined ? "decide" : "act"
      let emitted: ReadonlyArray<Event>
      if (definition?.decide !== undefined) {
        emitted = definition.decide(log, yield* Clock.currentTimeMillis, context)
      } else if (definition?.act !== undefined) {
        emitted = yield* definition.act(log, context)
      } else {
        return
      }
      if (emitted.length === 0) {
        return yield* Effect.die(
          new Error(`machine "${m.id}" wedged: the ${slot} of "${name}" emitted nothing`)
        )
      }
      yield* store.append(emitted)
      log = [...log, ...(yield* store.readFrom(seq))]
      seq = yield* store.head
      const seenAfter = viewOf(m, log)
      if (
        fold(m, seenAfter).name === name &&
        incarnationOf(seenAfter) === incarnationOf(seen)
      ) {
        return yield* Effect.die(
          new Error(`machine "${m.id}" wedged: the ${slot} of "${name}" did not transition`)
        )
      }
    }
  })

// Are all machines resting on this log? A runtime's alarm reads this to decide whether a backup
// wake is still owed.
export const resting = <R>(
  machines: ReadonlyArray<Machine<R, never>>,
  log: ReadonlyArray<Event>
) =>
  machines.every((m) => {
    const state = m.states[stateOf(m, log)]
    return state?.decide === undefined && state?.act === undefined
  })

// Settle a set of machines that share one log until none makes progress. Each machine folds the
// whole log through its own transitions and tolerates the others' events. The fixpoint is the
// watermark: a full pass that lands nothing is quiescence. The watermark rather than the length,
// because a store that absorbs a redelivered event leaves the length unchanged and that is exactly
// what "no progress" means.
export const settleAll = <R>(
  machines: ReadonlyArray<Machine<R, never>>
): Effect.Effect<void, never, EventLog | R> =>
  Effect.gen(function* () {
    const store = yield* EventLog
    while (true) {
      const before = yield* store.head
      for (const m of machines) yield* settle(m)
      if ((yield* store.head) === before) return
    }
  })
