import { describe, expect, test } from "bun:test"
import { foldOf, machine, resting, stateOf } from "./machine"
import type { Envelope } from "./envelope"

// Guarded transitions and fold purity. A guard is the fold's predicate: pure, total, and a function
// of the log up to its triggering event. These tests pin both the mechanic and the purity.

const ev = (type: string): Envelope => ({ type })

describe("guarded transitions", () => {
  const m = machine({
    id: "guarded",
    initial: "under",
    states: {
      // Flip to `over` only when a third X has been seen.
      under: {
        on: { X: { target: "over", when: (log) => log.filter((e) => e.type === "X").length >= 3 } }
      },
      over: {}
    }
  })

  test("a guard that does not hold leaves the state put", () => {
    expect(stateOf(m, [ev("X"), ev("X")])).toBe("under")
  })

  test("the guard sees the prefix up to and including its own event", () => {
    expect(stateOf(m, [ev("X"), ev("X")])).toBe("under")
    expect(stateOf(m, [ev("X"), ev("X"), ev("X")])).toBe("over")
  })

  test("a bare string transition goes straight to its target", () => {
    const plain = machine({ id: "plain", initial: "a", states: { a: { on: { Go: "b" } }, b: {} } })
    expect(stateOf(plain, [ev("Go")])).toBe("b")
  })

  test("an event no state transitions on changes nothing: tolerant reads", () => {
    expect(stateOf(m, [ev("Unknown"), ev("X"), ev("Whatever")])).toBe("under")
  })
})

describe("the malformed machine", () => {
  test("a state that defines both decide and act is rejected at definition time", () => {
    expect(() =>
      machine({
        id: "both",
        initial: "a",
        states: {
          a: {
            decide: () => [{ type: "X" }],
            act: () => {
              throw new Error("unreachable")
            }
          }
        }
      })
    ).toThrow('machine "both" malformed: the state "a" defines both decide and act')
  })
})

describe("decide purity", () => {
  // A decide derives events from the log and the passed `now` alone. Purity is enforced the same way
  // as for guards: run it with the ambient nondeterminism sources rigged to throw, and check that
  // two runs over the same inputs emit the same events.
  const m = machine({
    id: "recorder",
    initial: "idle",
    states: {
      idle: { on: { Fired: "recording" } },
      recording: {
        decide: (log, now) => [{ type: "Recorded", count: log.length, at: now }],
        on: { Recorded: "done" }
      },
      done: {}
    }
  })

  test("the same log and the same now emit the same events, with the clock rigged to throw", () => {
    const clock = Date.now
    const random = Math.random
    Date.now = () => {
      throw new Error("a decide read the clock")
    }
    Math.random = () => {
      throw new Error("a decide read the random source")
    }
    try {
      const log = [ev("Fired")]
      const decide = m.states.recording?.decide
      expect(decide?.(log, 7, undefined as never)).toEqual([{ type: "Recorded", count: 1, at: 7 }])
      expect(decide?.(log, 7, undefined as never)).toEqual(decide?.(log, 7, undefined as never))
    } finally {
      Date.now = clock
      Math.random = random
    }
  })
})

describe("assigned context", () => {
  // The fold carries data alongside the state name: a firing transition's `assign` folds its
  // triggering event into the machine's private context, and `foldOf` returns both.
  const m = machine<never, { readonly callId: string; readonly result?: unknown }>({
    id: "serving",
    initial: "idle",
    context: { callId: "" },
    states: {
      idle: {
        on: {
          Called: {
            target: "serving",
            assign: (_, e) => ({ callId: String((e as { callId?: unknown }).callId) })
          }
        }
      },
      serving: {
        on: {
          Settled: {
            target: "done",
            assign: (c, e) => ({ ...c, result: (e as { result?: unknown }).result })
          },
          Reset: "idle"
        }
      },
      done: {}
    }
  })

  test("a firing transition assigns, and the context accumulates across transitions", () => {
    const log: Array<Envelope> = [
      { type: "Called", callId: "c9" },
      { type: "Settled", result: 42 }
    ]
    expect(foldOf(m, log)).toEqual({ name: "done", context: { callId: "c9", result: 42 } })
  })

  test("an unmatched event changes neither the name nor the context", () => {
    const log: Array<Envelope> = [{ type: "Called", callId: "c9" }, { type: "Noise" }]
    expect(foldOf(m, log)).toEqual({ name: "serving", context: { callId: "c9" } })
  })

  test("a transition with no assign keeps the context, and an empty log folds to the initial one", () => {
    expect(foldOf(m, [])).toEqual({ name: "idle", context: { callId: "" } })
    const reset: Array<Envelope> = [{ type: "Called", callId: "c9" }, { type: "Reset" }]
    expect(foldOf(m, reset)).toEqual({ name: "idle", context: { callId: "c9" } })
  })
})

describe("views", () => {
  // A view narrows the log a machine folds. A turn-scoped machine sees one turn, so a count resets
  // when the next turn opens.
  const lastTurn = (log: ReadonlyArray<Envelope>) => {
    const turn = log.filter((e) => e.type === "TurnOpened").at(-1)
    if (turn === undefined) return []
    return log.slice(log.lastIndexOf(turn))
  }

  const m = machine({
    id: "per-turn",
    view: lastTurn,
    initial: "watching",
    states: {
      watching: {
        on: { Tick: { target: "tripped", when: (log) => log.filter((e) => e.type === "Tick").length >= 2 } }
      },
      tripped: {}
    }
  })

  test("the machine folds its view, so a new turn starts the count again", () => {
    expect(stateOf(m, [ev("TurnOpened"), ev("Tick"), ev("Tick")])).toBe("tripped")
    expect(stateOf(m, [ev("TurnOpened"), ev("Tick"), ev("Tick"), ev("TurnOpened"), ev("Tick")])).toBe(
      "watching"
    )
  })

  test("an empty view folds to the initial state, and that is quiescence", () => {
    expect(stateOf(m, [ev("Tick"), ev("Tick")])).toBe("watching")
  })
})

describe("resting", () => {
  const idle = machine({ id: "idle", initial: "a", states: { a: { on: { Go: "b" } }, b: {} } })
  const busy = machine({
    id: "busy",
    initial: "a",
    states: { a: { on: { Go: "b" } }, b: { decide: () => [ev("Done")], on: { Done: "a" } } }
  })

  test("machines rest when no machine sits in an active state", () => {
    expect(resting([idle, busy], [])).toBe(true)
    expect(resting([idle, busy], [ev("Go")])).toBe(false)
    expect(resting([idle], [ev("Go")])).toBe(true)
  })
})
