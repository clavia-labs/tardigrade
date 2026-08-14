import { Effect, Option } from "effect"
import { EventLog, type DedupKey } from "./event-log"
import { foldOf, foldStep, type Fold, type Machine } from "./machine"
import type { Event } from "./event"

// The conformance kit: the proof that a set of machines replays, and that the store under them
// keeps the promises the log port asks for.
//
// Replay is the property the whole framework rests on. It is also the property a type can not
// express: nothing stops a guard from calling `Date.now`, and nothing stops a decide from reading a
// counter that lives outside the log. The kit closes that gap by running the folds twice with the
// ambient sources of nondeterminism rigged to throw, and by comparing the two runs.
//
// The kit is the core's answer to a determinism test that only covers its own fixtures. A harness
// registers its machines and its recorded logs, and the kit proves those machines, not
// hand-picked ones. A third-party harness runs it in its own test suite for the same reason.
//
// Four properties, and each failure names the machine and the state that broke it.
//
// - purity      every guard, every assign, and every decide is a pure function of the log
// - idempotence a second settle over an unchanged log appends nothing
// - wedge       every active state emits and transitions, so no settle loops forever
// - dedup       a redelivered event lands once
//
// The kit runs no `act`. An act reaches the model, the sandbox, or the network, and a report that
// called the world would cost money and would not be a report. Everything the kit checks about an
// act, it checks from the act's declaration: whether the state it sits in can ever be left, and
// whether a settled log would run it again.

export interface Check {
  readonly ok: boolean
  readonly failures: ReadonlyArray<string>
}

export interface ConformanceReport {
  readonly ok: boolean
  readonly purity: Check
  readonly idempotence: Check
  readonly wedge: Check
  readonly dedup: Check
}

export interface ConformanceOptions {
  readonly machines: ReadonlyArray<Machine<unknown, never>>
  readonly logs: ReadonlyArray<ReadonlyArray<Event>>
  // The key policy the store under test derives dedup keys with. It is required, and it is the same
  // function the runtime was bound with, so the kit reads the log the way the store does.
  //
  // It was optional once, and that made the dedup check a green tick nobody earned: under the
  // core's own `dedupKey` no harness event carries a key, so the probe has nothing to absorb and
  // the log scan has nothing to compare. A report that passes for the wrong reason is worse
  // than no report. Pass `dedupKey` to say plainly that events state their own keys.
  readonly keyOf: DedupKey
}

// The event the dedup probe appends twice. It carries its own key, and no machine transitions on
// its type, so it is inert to every fold that meets it later.
const PROBE_KEY = "flamecast/conformance/dedup-probe"
const PROBE: Event = { type: "ConformanceProbe", key: PROBE_KEY }

// The clock reading every decide in the kit is given. A decide is a pure function of the log and
// `now`, so a fixed reading is the whole point: two runs with the same reading owe the same events.
const NOW = 0

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Run a synchronous fold with the ambient sources of nondeterminism rigged to throw. A guard or a
// decide that reaches for the clock or the random source fails here rather than on replay, months
// later, in production. The window is synchronous, so no other fiber can observe the rigging.
const rigged = <A>(run: () => A): A => {
  const clock = Date.now
  const random = Math.random
  Date.now = () => {
    throw new Error("read the clock")
  }
  Math.random = () => {
    throw new Error("read the random source")
  }
  try {
    return run()
  } finally {
    Date.now = clock
    Math.random = random
  }
}

// Structural equality over fold results and emitted events. Two runs of a pure function owe equal
// values, and equal here has to mean equal by shape: a fold rebuilds its context on every pass, so
// reference equality would report every honest machine as impure.
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && same(left[key], right[key]))
}

// The state a machine sits in after each prefix of a log, from the empty prefix onward.
//
// A machine with no view folds one event at a time, because re-folding every prefix of a stored
// log from the start is quadratic and a stored log is long. A machine with a view
// re-derives its slice for each prefix, because a view is a function of the whole log and the
// prefix of a view is not the view of a prefix.
const trace = <C>(m: Machine<unknown, C>, log: ReadonlyArray<Event>) => {
  const states: Array<Fold<C>> = []
  let at = foldOf(m, [])
  states.push(at)
  for (let index = 0; index < log.length; index++) {
    try {
      at = m.view === undefined ? foldStep(m, at, log, index) : foldOf(m, log.slice(0, index + 1))
    } catch (error) {
      throw new Error(
        `the fold of state "${at.name}" threw on event "${log[index]?.type ?? ""}": ${reasonOf(error)}`
      )
    }
    states.push(at)
  }
  return states
}

const targetOf = (transition: string | { readonly target: string }) =>
  typeof transition === "string" ? transition : transition.target

const checkOf = (failures: ReadonlyArray<string>): Check => ({ ok: failures.length === 0, failures })

export const conformance = (options: ConformanceOptions) =>
  Effect.gen(function* () {
    const keyOf = options.keyOf
    const purity = new Set<string>()
    const idempotence = new Set<string>()
    const wedge = new Set<string>()
    const dedup = new Set<string>()

    for (const m of options.machines) {
      // The wedge check that needs no log: an active state with no way out can only be
      // entered once and never left, so the first settle that reaches it never returns.
      for (const [name, definition] of Object.entries(m.states)) {
        if (definition.decide === undefined && definition.act === undefined) continue
        const leaves = Object.values(definition.on ?? {}).some((t) => targetOf(t) !== name)
        if (!leaves) {
          wedge.add(
            `machine "${m.id}": the active state "${name}" declares no transition that leaves it, so a settle can not stop`
          )
        }
      }

      for (const [index, recorded] of options.logs.entries()) {
        let states: ReadonlyArray<Fold<never>>
        try {
          const first = rigged(() => trace(m, recorded))
          const second = rigged(() => trace(m, recorded))
          const drift = first.findIndex((state, i) => !same(state, second[i]))
          if (drift !== -1) {
            purity.add(
              `machine "${m.id}": folding log ${index} twice gave "${first[drift]?.name}" then "${second[drift]?.name}" after ${drift} event(s)`
            )
          }
          states = first
        } catch (error) {
          purity.add(`machine "${m.id}" on log ${index}: ${reasonOf(error)}`)
          continue
        }

        // Every prefix that leaves the machine in an active decide state is a decide the kit can
        // run: pure, cheap, and exactly what a replay would run at that point.
        for (const [prefix, at] of states.entries()) {
          const definition = m.states[at.name]
          const decide = definition?.decide
          if (decide === undefined) continue
          const log = recorded.slice(0, prefix)
          let emitted: ReadonlyArray<Event>
          try {
            emitted = rigged(() => decide(log, NOW, at.context))
            if (!same(emitted, rigged(() => decide(log, NOW, at.context)))) {
              purity.add(
                `machine "${m.id}": the decide of "${at.name}" emitted two different results for one log`
              )
              continue
            }
          } catch (error) {
            purity.add(`machine "${m.id}": the decide of "${at.name}" threw: ${reasonOf(error)}`)
            continue
          }
          if (emitted.length === 0) {
            wedge.add(`machine "${m.id}": the decide of "${at.name}" emitted nothing`)
          } else if (!emitted.some((event) => definition?.on?.[event.type] !== undefined)) {
            wedge.add(
              `machine "${m.id}": the decide of "${at.name}" emitted ${emitted
                .map((event) => `"${event.type}"`)
                .join(", ")} and that state transitions on none of them`
            )
          }
          // The last prefix is the whole log, so this decide is what a second settle would
          // run over an unchanged log.
          if (prefix === recorded.length && emitted.length > 0) {
            idempotence.add(
              `machine "${m.id}": a second settle of log ${index} appends ${emitted.length} event(s) from the decide of "${at.name}"`
            )
          }
        }

        const end = states[states.length - 1]
        if (end !== undefined && m.states[end.name]?.act !== undefined) {
          idempotence.add(
            `machine "${m.id}": a second settle of log ${index} runs the act of "${end.name}" again`
          )
        }
      }
    }

    // A recorded log that holds one key twice is the evidence that the store it came from
    // let a redelivered event land.
    for (const [index, log] of options.logs.entries()) {
      const seen = new Map<string, number>()
      for (const [position, event] of log.entries()) {
        const key = keyOf(event)
        if (key === undefined) continue
        const prior = seen.get(key)
        if (prior === undefined) seen.set(key, position)
        else {
          dedup.add(
            `log ${index}: the key "${key}" lands twice, at ${prior} and ${position}, so a redelivered "${event.type}" was not absorbed`
          )
        }
      }
    }

    // When a runtime is bound, the kit proves the store itself absorbs a redelivery. It appends one
    // keyed probe event twice and expects one of them to land. The probe is read through the
    // service option rather than the requirement channel, so the same call works with no runtime at
    // all, which is how a harness runs the kit over its machines alone.
    const store = yield* Effect.serviceOption(EventLog)
    if (Option.isSome(store) && keyOf(PROBE) !== undefined) {
      const log = store.value
      const before = yield* log.head
      yield* log.append([PROBE])
      const once = yield* log.head
      yield* log.append([PROBE])
      const landed = (yield* log.readFrom(before)).filter((event) => event.type === PROBE.type)
      if (once <= before) dedup.add("the store appended no event for a keyed batch, so nothing landed")
      if ((yield* log.head) !== once) {
        dedup.add(`the store appended a redelivered event twice for the key "${PROBE_KEY}"`)
      }
      if (landed.length !== 1) {
        dedup.add(`the store returned ${landed.length} copies of one redelivered event from its watermark`)
      }
    }

    const report: ConformanceReport = {
      ok: purity.size === 0 && idempotence.size === 0 && wedge.size === 0 && dedup.size === 0,
      purity: checkOf([...purity]),
      idempotence: checkOf([...idempotence]),
      wedge: checkOf([...wedge]),
      dedup: checkOf([...dedup])
    }
    return report
  })
