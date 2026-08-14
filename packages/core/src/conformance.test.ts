import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { conformance, type ConformanceOptions } from "./conformance"
import { dedupKey, type DedupKey } from "./event-log"
import { erase, machine } from "./machine"
import type { Event } from "./event"

// The kit has to fail the machines it is meant to fail. A conformance report that passes everything
// proves nothing, so every check here is driven by a fixture built to break exactly one property.

const ev = (type: string): Event => ({ type })

// The kit requires a key policy rather than assuming one. These fixtures run under the core's own,
// where an event states its own key, and the file says so once here.
const run = ({
  keyOf = dedupKey,
  ...options
}: Omit<ConformanceOptions, "keyOf"> & { readonly keyOf?: DedupKey }) =>
  Effect.runPromise(conformance({ ...options, keyOf }))

// The reference machine: pure guard, pure decide, a transition out of every active state.
const answering = machine({
  id: "answering",
  initial: "idle",
  states: {
    idle: { on: { Asked: "answering" } },
    answering: {
      decide: (log, now) => [{ type: "Answered", count: log.length, at: now }],
      on: { Answered: "idle" }
    }
  }
})

const settled = [ev("Asked"), ev("Answered")]

describe("a machine that replays", () => {
  test("passes every check", async () => {
    const report = await run({ machines: [answering], logs: [settled] })
    expect(report).toEqual({
      ok: true,
      purity: { ok: true, failures: [] },
      idempotence: { ok: true, failures: [] },
      wedge: { ok: true, failures: [] },
      dedup: { ok: true, failures: [] }
    })
  })

  test("passes with a view, a context, and an act state at rest", async () => {
    const perTurn = machine<never, { readonly seen: number }>({
      id: "per-turn",
      view: (log) => log.slice(log.findLastIndex((e) => e.type === "TurnOpened")),
      initial: "watching",
      context: { seen: 0 },
      states: {
        watching: {
          on: { Tick: { target: "dispatching", assign: (c) => ({ seen: c.seen + 1 }) } }
        },
        dispatching: {
          act: () => Effect.succeed([ev("Dispatched")]),
          on: { Dispatched: "watching" }
        }
      }
    })

    const report = await run({
      machines: [answering, erase(perTurn)],
      logs: [[ev("TurnOpened"), ev("Tick"), ev("Dispatched")], settled]
    })
    expect(report.ok).toBe(true)
  })

  test("folds an event alphabet it has never met without complaint", async () => {
    const report = await run({
      machines: [answering],
      logs: [[ev("Asked"), ev("SomethingFromTheFuture"), ev("Answered")]]
    })
    expect(report.ok).toBe(true)
  })
})

describe("purity", () => {
  // The headline case: a guard that reads the wall clock folds to a different state on replay.
  test("fails a guard that reads the clock, and names the machine and the state", async () => {
    const impure = machine({
      id: "clock-guard",
      initial: "watching",
      states: {
        watching: { on: { Tick: { target: "tripped", when: () => Date.now() > 0 } } },
        tripped: {}
      }
    })

    const report = await run({ machines: [impure], logs: [[ev("Tick")]] })
    expect(report.ok).toBe(false)
    expect(report.purity.ok).toBe(false)
    expect(report.purity.failures).toEqual([
      'machine "clock-guard" on log 0: the fold of state "watching" threw on event "Tick": read the clock'
    ])
  })

  test("fails a decide that reads the random source", async () => {
    const impure = machine({
      id: "roller",
      initial: "idle",
      states: {
        idle: { on: { Fired: "rolling" } },
        rolling: {
          decide: () => [{ type: "Rolled", value: Math.random() }],
          on: { Rolled: "idle" }
        }
      }
    })

    const report = await run({ machines: [impure], logs: [[ev("Fired")]] })
    expect(report.purity.failures).toEqual([
      'machine "roller": the decide of "rolling" threw: read the random source'
    ])
  })

  test("fails an assign that reads the clock", async () => {
    const impure = machine<never, { readonly at: number }>({
      id: "stamper",
      initial: "idle",
      context: { at: 0 },
      states: {
        idle: { on: { Fired: { target: "done", assign: () => ({ at: Date.now() }) } } },
        done: {}
      }
    })

    const report = await run({ machines: [erase(impure)], logs: [[ev("Fired")]] })
    expect(report.purity.failures).toEqual([
      'machine "stamper" on log 0: the fold of state "idle" threw on event "Fired": read the clock'
    ])
  })

  // Nondeterminism does not need the clock. A guard that reads state outside the log folds two ways
  // over one log, and the two-run comparison is what catches it.
  test("fails a guard that reads state living outside the log", async () => {
    let flips = 0
    const impure = machine({
      id: "flaky",
      initial: "a",
      states: {
        a: {
          on: {
            X: {
              target: "b",
              when: () => {
                flips += 1
                return flips % 2 === 1
              }
            }
          }
        },
        b: {}
      }
    })

    const report = await run({ machines: [impure], logs: [[ev("X")]] })
    expect(report.purity.failures).toEqual([
      'machine "flaky": folding log 0 twice gave "b" then "a" after 1 event(s)'
    ])
  })

  test("fails a decide that emits a different result for one log", async () => {
    let calls = 0
    const impure = machine({
      id: "drifting",
      initial: "idle",
      states: {
        idle: { on: { Fired: "emitting" } },
        emitting: {
          decide: () => {
            calls += 1
            return [{ type: "Emitted", nth: calls }]
          },
          on: { Emitted: "idle" }
        }
      }
    })

    const report = await run({ machines: [impure], logs: [[ev("Fired")]] })
    expect(report.purity.failures).toEqual([
      'machine "drifting": the decide of "emitting" emitted two different results for one log'
    ])
  })
})

describe("wedge", () => {
  test("fails an active state that declares no way out", async () => {
    const stuck = machine({
      id: "stuck",
      initial: "spinning",
      states: { spinning: { decide: () => [ev("Noise")] } }
    })

    const report = await run({ machines: [stuck], logs: [[]] })
    expect(report.wedge.ok).toBe(false)
    expect(report.wedge.failures).toContain(
      'machine "stuck": the active state "spinning" declares no transition that leaves it, so a settle can not stop'
    )
  })

  test("fails a decide that emits nothing", async () => {
    const silent = machine({
      id: "silent",
      initial: "idle",
      states: {
        idle: { on: { Fired: "thinking" } },
        thinking: { decide: () => [], on: { Thought: "idle" } }
      }
    })

    const report = await run({ machines: [silent], logs: [[ev("Fired")]] })
    expect(report.wedge.failures).toEqual([
      'machine "silent": the decide of "thinking" emitted nothing'
    ])
  })

  test("fails a decide whose emissions do not move the machine", async () => {
    const spinning = machine({
      id: "spinning",
      initial: "idle",
      states: {
        idle: { on: { Fired: "thinking" } },
        thinking: { decide: () => [ev("Mumble")], on: { Thought: "idle" } }
      }
    })

    const report = await run({ machines: [spinning], logs: [[ev("Fired")]] })
    expect(report.wedge.failures).toEqual([
      'machine "spinning": the decide of "thinking" emitted "Mumble" and that state transitions on none of them'
    ])
  })

  test("passes an act state, which the kit judges from its declaration", async () => {
    const acting = machine({
      id: "acting",
      initial: "idle",
      states: {
        idle: { on: { Fired: "working" } },
        working: { act: () => Effect.succeed([ev("Worked")]), on: { Worked: "idle" } }
      }
    })

    const report = await run({ machines: [acting], logs: [[ev("Fired"), ev("Worked")]] })
    expect(report.ok).toBe(true)
  })
})

describe("idempotence", () => {
  test("fails a log a second settle would append to", async () => {
    const report = await run({ machines: [answering], logs: [[ev("Asked")]] })
    expect(report.idempotence.ok).toBe(false)
    expect(report.idempotence.failures).toEqual([
      'machine "answering": a second settle of log 0 appends 1 event(s) from the decide of "answering"'
    ])
  })

  test("fails a log that stopped inside an act", async () => {
    const acting = machine({
      id: "acting",
      initial: "idle",
      states: {
        idle: { on: { Fired: "working" } },
        working: { act: () => Effect.succeed([ev("Worked")]), on: { Worked: "idle" } }
      }
    })

    const report = await run({ machines: [acting], logs: [[ev("Fired")]] })
    expect(report.idempotence.failures).toEqual([
      'machine "acting": a second settle of log 0 runs the act of "working" again'
    ])
  })

  test("runs no act while it checks", async () => {
    let ran = 0
    const acting = machine({
      id: "acting",
      initial: "idle",
      states: {
        idle: { on: { Fired: "working" } },
        working: {
          act: () =>
            Effect.sync(() => {
              ran += 1
              return [ev("Worked")]
            }),
          on: { Worked: "idle" }
        }
      }
    })

    await run({ machines: [acting], logs: [[ev("Fired")]] })
    expect(ran).toBe(0)
  })
})

describe("dedup", () => {
  test("fails a log where one key landed twice", async () => {
    const log: Array<Event> = [
      { type: "MessageReceived", key: "msg:m-1" },
      { type: "Answered" },
      { type: "MessageReceived", key: "msg:m-1" }
    ]

    const report = await run({ machines: [], logs: [log] })
    expect(report.dedup.ok).toBe(false)
    expect(report.dedup.failures).toEqual([
      'log 0: the key "msg:m-1" lands twice, at 0 and 2, so a redelivered "MessageReceived" was not absorbed'
    ])
  })

  test("passes a log whose keys are unique, and ignores unkeyed repeats", async () => {
    const log: Array<Event> = [
      { type: "MessageReceived", key: "msg:m-1" },
      { type: "Mark" },
      { type: "Mark" },
      { type: "MessageReceived", key: "msg:m-2" }
    ]

    const report = await run({ machines: [], logs: [log] })
    expect(report.dedup.ok).toBe(true)
  })

  // A harness that derives its keys from its own event alphabet passes the derivation in, and the
  // kit reads the log the way that harness's store does.
  test("reads keys through the policy the caller passes", async () => {
    const log: Array<Event> = [
      { type: "ToolReturned", callId: "c-1" },
      { type: "ToolReturned", callId: "c-1" }
    ]

    const report = await run({
      machines: [],
      logs: [log],
      keyOf: (event) => (event.type === "ToolReturned" ? `tr:${String(event.callId)}` : undefined)
    })
    expect(report.dedup.failures).toEqual([
      'log 0: the key "tr:c-1" lands twice, at 0 and 1, so a redelivered "ToolReturned" was not absorbed'
    ])
  })
})

describe("the report", () => {
  test("gathers every failure rather than stopping at the first", async () => {
    const impure = machine({
      id: "broken",
      initial: "idle",
      states: {
        idle: { on: { Fired: "thinking" } },
        thinking: { decide: () => [], on: { Thought: "idle" } }
      }
    })

    const report = await run({
      machines: [answering, impure],
      logs: [[ev("Asked")], [ev("Fired"), { type: "Mark", key: "k" }, { type: "Mark", key: "k" }]]
    })
    expect(report.ok).toBe(false)
    expect(report.wedge.failures).toHaveLength(1)
    expect(report.idempotence.failures).toHaveLength(1)
    expect(report.dedup.failures).toHaveLength(1)
  })
})
