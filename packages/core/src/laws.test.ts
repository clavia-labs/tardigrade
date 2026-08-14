import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import * as FastCheck from "fast-check"
import { EventLog, dedupKey } from "./event-log"
import { foldOf, foldStep, machine, settle, settleAll } from "./machine"
import { actor, send } from "./actor"
import type { Event } from "./event"

// The kernel's laws. The types enforce the pure/effectful split; these properties enforce the
// algebraic equations the types can not express. Determinism is what replay rests on, decomposition
// is what makes compaction sound, and idempotence is what makes a crashed turn safe to re-drive.
//
// The log these tests settle over is a small array binding declared here rather than imported from
// @flamecast/runtime-in-memory. The dependency runs one way: a runtime imports the core, so the core's
// own tests can not import a runtime. The binding below is the shortest honest store that keeps the
// six guarantees the port asks for.
const testLog = (seed: ReadonlyArray<Event> = []) => {
  const rows: Array<{ seq: number; event: Event }> = []
  const keys = new Set<string>()
  let seq = 0
  const put = (events: ReadonlyArray<Event>) => {
    for (const event of events) {
      const key = dedupKey(event)
      if (key !== undefined && keys.has(key)) continue
      if (key !== undefined) keys.add(key)
      seq += 1
      rows.push({ seq, event })
    }
  }
  put(seed)
  return Layer.succeed(EventLog, {
    append: (events) => Effect.sync(() => put(events)),
    read: Effect.sync(() => rows.map((row) => row.event)),
    readFrom: (from) => Effect.sync(() => rows.filter((row) => row.seq > from).map((row) => row.event)),
    head: Effect.sync(() => rows.at(-1)?.seq ?? 0)
  })
}

const readLog = Effect.gen(function* () {
  const store = yield* EventLog
  return yield* store.read
})

const ev = (type: string): Event => ({ type })

// The wedge is a defect, so it arrives on the Exit as a Die rather than as a typed error.
const died = async (program: Effect.Effect<unknown>) => {
  const exit = await Effect.runPromiseExit(program)
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "the program did not die"
}

// A counter machine with one guard and one assign, so every pure half of the fold is under test.
const counter = machine<never, { readonly ticks: number }>({
  id: "counter",
  initial: "under",
  context: { ticks: 0 },
  states: {
    under: {
      on: {
        Tick: {
          target: "under",
          assign: (c) => ({ ticks: c.ticks + 1 })
        },
        Trip: { target: "over", when: (log) => log.filter((e) => e.type === "Tick").length >= 2 }
      }
    },
    over: { on: { Reset: "under" } }
  }
})

const alphabet = ["Tick", "Trip", "Reset", "Noise"] as const
const logs = FastCheck.array(
  FastCheck.constantFrom(...alphabet).map((type) => ({ type }) as Event),
  { maxLength: 40 }
)
const runs = { numRuns: 200 }

describe("laws", () => {
  // The fold is a pure function of the log. This closes the gap the type can not: a guard could call
  // Date.now or Math.random and the signature would not notice. Determinism is what replay rests on,
  // so the ambient sources are rigged to throw for the whole property.
  test("law: the fold is deterministic", () => {
    const clock = Date.now
    const random = Math.random
    Date.now = () => {
      throw new Error("the fold read the clock")
    }
    Math.random = () => {
      throw new Error("the fold read the random source")
    }
    try {
      FastCheck.assert(
        FastCheck.property(logs, (log) => {
          expect(foldOf(counter, log)).toEqual(foldOf(counter, log))
        }),
        runs
      )
    } finally {
      Date.now = clock
      Math.random = random
    }
  })

  // The fold decomposes: folding the whole log equals resuming from the fold of a prefix and
  // stepping the rest. This is the snapshot law, and it is what makes compaction sound. A checkpoint
  // stands in for the prefix it covers, and the read model does not move. It holds for a genuine
  // left fold; a fold that carried state outside its accumulator would break it.
  test("law: the fold decomposes, so a checkpoint stands in for its prefix", () => {
    FastCheck.assert(
      FastCheck.property(logs, FastCheck.nat({ max: 40 }), (log, cut) => {
        const at = Math.min(cut, log.length)
        let resumed = foldOf(counter, log.slice(0, at))
        for (let index = at; index < log.length; index++) resumed = foldStep(counter, resumed, log, index)
        expect(resumed).toEqual(foldOf(counter, log))
      }),
      runs
    )
  })

  // Every event carries forward: appending later events never rewrites what an earlier prefix folded
  // to. This is what "an event is a fact about the past" means for the fold.
  test("law: a prefix folds the same whether or not the tail exists", () => {
    FastCheck.assert(
      FastCheck.property(logs, logs, (xs, ys) => {
        expect(foldOf(counter, xs)).toEqual(foldOf(counter, [...xs, ...ys].slice(0, xs.length)))
      }),
      runs
    )
  })

  // A settle runs a machine to rest. A second settle over the log the first one left appends
  // nothing, which is the property that makes a re-drive after a crash free.
  test("law: settle is idempotent", async () => {
    const m = machine({
      id: "answering",
      initial: "idle",
      states: {
        idle: { on: { Asked: "answering" } },
        answering: {
          decide: (_log, now) => [{ type: "Answered", at: now }],
          on: { Answered: "idle" }
        }
      }
    })

    const program = Effect.gen(function* () {
      const store = yield* EventLog
      yield* store.append([ev("Asked")])
      yield* settle(m)
      const once = yield* store.read
      yield* settle(m)
      const twice = yield* store.read
      return { once, twice }
    })

    const { once, twice } = await Effect.runPromise(Effect.provide(program, testLog()))
    expect(once.map((e) => e.type)).toEqual(["Asked", "Answered"])
    expect(twice).toEqual(once)
  })

  // A redelivered event is absorbed by its key, so the log holds one copy and the fold does not
  // count the delivery twice.
  test("law: a redelivered event lands once and the fold does not move", async () => {
    const message: Event = { type: "Tick", key: "msg:m-1" }
    const program = Effect.gen(function* () {
      const store = yield* EventLog
      yield* store.append([message])
      const first = yield* store.read
      yield* store.append([message])
      const second = yield* store.read
      return { first, second }
    })

    const { first, second } = await Effect.runPromise(Effect.provide(program, testLog()))
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(foldOf(counter, second)).toEqual(foldOf(counter, first))
  })

  // A crash between an act and its append re-runs the act: delivery is at-least-once. A crash after
  // the append does not, because the committed event moved the fold past that state. This test
  // settles a log that already holds the act's outcome and proves the act stays unrun.
  test("law: a committed act does not run again on resume", async () => {
    let calls = 0
    const m = machine({
      id: "dispatcher",
      initial: "idle",
      states: {
        idle: { on: { Called: "dispatching" } },
        dispatching: {
          act: () =>
            Effect.sync(() => {
              calls += 1
              return [{ type: "Returned", callId: "c-1" }]
            }),
          on: { Returned: "idle" }
        },
        // A resting state is where the loop stops.
        done: {}
      }
    })

    const fresh = Effect.gen(function* () {
      const store = yield* EventLog
      yield* store.append([ev("Called")])
      yield* settle(m)
      return yield* store.read
    })
    const complete = await Effect.runPromise(Effect.provide(fresh, testLog()))
    expect(calls).toBe(1)
    expect(complete.map((e) => e.type)).toEqual(["Called", "Returned"])

    // Resume: the crashed process comes back and settles the log it left behind.
    await Effect.runPromise(Effect.provide(settle(m), testLog(complete)))
    expect(calls).toBe(1)

    // The other half of the seam: a crash before the append leaves the machine in the act state, and
    // the resume runs the act once more. At-least-once is the contract an act is written against.
    await Effect.runPromise(Effect.provide(settle(m), testLog([ev("Called")])))
    expect(calls).toBe(2)
  })

  // settleAll reaches a fixpoint across machines that share one log. Each machine folds the whole
  // log through its own transitions and tolerates the events the others emitted.
  test("law: settleAll runs machines to a shared fixpoint", async () => {
    const first = machine({
      id: "first",
      initial: "idle",
      states: {
        idle: { on: { Start: "working" } },
        working: { decide: () => [ev("Half")], on: { Half: "idle" } }
      }
    })
    const second = machine({
      id: "second",
      initial: "idle",
      states: {
        idle: { on: { Half: "finishing" } },
        finishing: { decide: () => [ev("Whole")], on: { Whole: "idle" } }
      }
    })

    const program = Effect.gen(function* () {
      yield* send(actor([first, second]), ev("Start"))
      return yield* readLog
    })
    const log = await Effect.runPromise(Effect.provide(program, testLog()))
    expect(log.map((e) => e.type)).toEqual(["Start", "Half", "Whole"])
  })

  // A wedge is a bug, and the runtime says so rather than looping. Both shapes die: a slot that
  // emits nothing, and a slot whose emissions leave the machine where it was.
  test("law: a settle dies on a wedge rather than looping", async () => {
    const silent = machine({
      id: "silent",
      initial: "stuck",
      states: { stuck: { decide: () => [], on: { Never: "done" } }, done: {} }
    })
    const spinning = machine({
      id: "spinning",
      initial: "stuck",
      states: { stuck: { decide: () => [ev("Noise")], on: { Never: "done" } }, done: {} }
    })

    expect(await died(Effect.provide(settle(silent), testLog()))).toContain(
      'machine "silent" wedged: the decide of "stuck" emitted nothing'
    )
    expect(await died(Effect.provide(settle(spinning), testLog()))).toContain(
      'machine "spinning" wedged: the decide of "stuck" did not transition'
    )
  })

  // The settle loop tracks the tail it appends through the watermark rather than re-reading the
  // whole log, so a store that absorbs a redelivered event still folds the truth. A decide that
  // re-emits a keyed event it already committed appends nothing, and the loop stops.
  test("law: the settle loop reads what landed, not what it emitted", async () => {
    const m = machine({
      id: "keyed",
      initial: "idle",
      states: {
        idle: { on: { Asked: "answering" } },
        answering: {
          decide: () => [{ type: "Answered", key: "answer:1" }],
          on: { Answered: "idle" }
        }
      }
    })

    const program = Effect.gen(function* () {
      const store = yield* EventLog
      yield* settle(m)
      return yield* store.read
    })
    // The log already holds the answer under its key, so the redelivery is absorbed and the machine
    // still leaves the active state.
    const log = await Effect.runPromise(
      Effect.provide(program, testLog([ev("Asked"), { type: "Answered", key: "answer:1" }]))
    )
    expect(log.filter((e) => e.type === "Answered")).toHaveLength(1)
  })

  // A crash lands mid-turn, so the resume meets a log where some acts committed and some never ran.
  // The committed one stays done and the turn finishes from where it stopped.
  test("law: a resume finishes a partial turn and repeats no committed act", async () => {
    const ran: Array<string> = []
    const m = machine({
      id: "turn",
      initial: "idle",
      states: {
        idle: { on: { Asked: "calling" } },
        calling: {
          act: () =>
            Effect.sync(() => {
              ran.push("model")
              return [ev("ModelReturned")]
            }),
          on: { ModelReturned: "dispatching" }
        },
        dispatching: {
          act: () =>
            Effect.sync(() => {
              ran.push("tool")
              return [ev("ToolReturned")]
            }),
          on: { ToolReturned: "done" }
        },
        done: {}
      }
    })

    // The crash left the model call committed and the tool dispatch unrun.
    const partial = [ev("Asked"), ev("ModelReturned")]
    const log = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* settleAll([m])
          return (yield* EventLog).read
        }).pipe(Effect.flatten),
        testLog(partial)
      )
    )

    expect(ran).toEqual(["tool"])
    expect(log.map((e) => e.type)).toEqual(["Asked", "ModelReturned", "ToolReturned"])
  })
})
