import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@tardigrade/core/event"
import { EventLog, withWatermark } from "@tardigrade/core/event-log"
import { budgetReactor, budgetOf, usedOf, budgetPhase, budgetSpent, canRequestBudget } from "./budget"
import { toolsReactor } from "./tools"

// A turn: a `MessageReceived` head carrying `budget`, then `calls` execute tool-calls (each answered
// except the last), then any extra events appended after.
const turn = (calls: number, budget?: number, extra: Event[] = []): Event[] => {
  const id = "m1"
  const log: Event[] = [{ type: "MessageReceived", id, text: "go", ...(budget === undefined ? {} : { budget }), at: 0 }]
  for (let i = 1; i <= calls; i++) {
    log.push({ type: "ToolCalled", callId: `c${i}`, name: "execute", arguments: { code: `x${i}` }, turn: id, at: i * 2 })
    if (i < calls) log.push({ type: "ToolReturned", callId: `c${i}`, result: {}, turn: id, at: i * 2 + 1 })
  }
  return [...log, ...extra]
}

// Drive the reactor over an in-memory log and return only what serving appended.
const fire = async (log: ReadonlyArray<Event>): Promise<ReadonlyArray<Event>> => {
  const events: Event[] = [...log]
  const memory = Layer.succeed(EventLog, withWatermark({
    append: (more: ReadonlyArray<Event>) => Effect.sync(() => void events.push(...more)),
    read: Effect.sync(() => events as ReadonlyArray<Event>)
  }))
  const derived = budgetReactor(events)
  if (derived.length > 0) {
    const out = await Effect.runPromise(derived[0]!.act(derived[0]!.input).pipe(Effect.provide(memory)) as Effect.Effect<ReadonlyArray<Event>>)
    events.push(...out)
  }
  return events.slice(log.length)
}

describe("the budget reactor", () => {
  test("rests while under budget", () => {
    expect(budgetReactor(turn(2, 2))).toHaveLength(0) // two calls, budget two
  })

  test("owes the wall on the call that passes the budget", () => {
    expect(budgetReactor(turn(3, 2))).toHaveLength(1) // third call, budget two
  })

  test("with no budget it rests up to the generous default", () => {
    expect(budgetReactor(turn(5))).toHaveLength(0)
  })

  test("serving fires BudgetExhausted once, with the counts", async () => {
    const log = turn(3, 2)
    const emitted = await fire(log)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1" })
    // Once the event is on the log the wall stands, so it fires only once.
    // Once the event is on the log the key is recorded; derivation still declares (declaring is
    // free), and the runtime's diff retires it. The reactor-level fact is the same wall.
    expect(budgetReactor([...log, emitted[0]!]).every((t) => t.key === `bw:m1/2`)).toBe(true)
  })

  test("budgetOf and usedOf read the turn", () => {
    const log = turn(3, 7)
    expect(budgetOf(log)).toBe(7)
    expect(usedOf(log)).toBe(3)
  })

  test("the guard is pure: the fold runs with the clock and randomness rigged to throw", () => {
    const realNow = Date.now
    const realRandom = Math.random
    Date.now = () => {
      throw new Error("clock in the budget guard")
    }
    Math.random = () => {
      throw new Error("random in the budget guard")
    }
    try {
      expect(budgetReactor(turn(3, 2))).toHaveLength(1)
    } finally {
      Date.now = realNow
      Math.random = realRandom
    }
  })
})

describe("the tools gate reacts to BudgetExhausted", () => {
  // Drive the reactor over an in-memory log and return only what serving appended.
  const dispatch = async (log: ReadonlyArray<Event>): Promise<ReadonlyArray<Event>> => {
    const events: Event[] = [...log]
    const memory = Layer.succeed(EventLog, withWatermark({
      append: (more: ReadonlyArray<Event>) => Effect.sync(() => void events.push(...more)),
      read: Effect.sync(() => events as ReadonlyArray<Event>)
    }))
    const derived = toolsReactor(events)
    if (derived.length > 0) {
      const out = await Effect.runPromise(derived[0]!.act(derived[0]!.input).pipe(Effect.provide(memory)) as Effect.Effect<ReadonlyArray<Event>>)
      events.push(...out)
    }
    return events.slice(log.length)
  }

  test("with no wall on the turn, execute dispatches", async () => {
    const out = await dispatch(turn(2, 12))
    expect(out[0]!.type).toBe("CodeDispatched")
  })

  test("once BudgetExhausted is on the turn, the work tool is refused with an answer nudge", async () => {
    const log = turn(3, 2, [{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 99 }])
    const out = await dispatch(log)
    expect(out[0]!.type).toBe("ToolReturned")
    const refusal = String((out[0] as { result?: { error?: string } }).result?.error)
    expect(refusal).toContain("Tool budget reached")
    expect(refusal).toContain("Answer now")
  })
})

// The lifecycle events, appended after a spent turn's execute calls.
const exhausted: Event = { type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 100 }
const granted = (amount: number): Event => ({ type: "BudgetGranted", amount, turn: "m1", at: 101 })
const denied: Event = { type: "BudgetDenied", reason: "no", turn: "m1", at: 101 }

describe("the escalation lifecycle", () => {
  test("usedOf counts only execute; answer and request_budget are free", () => {
    const log: Event[] = [
      { type: "MessageReceived", id: "m1", text: "go", budget: 5, at: 0 },
      { type: "ToolCalled", callId: "e1", name: "execute", arguments: {}, turn: "m1", at: 1 },
      { type: "ToolCalled", callId: "rb1", name: "request_budget", arguments: {}, turn: "m1", at: 2 },
      { type: "ToolCalled", callId: "a1", name: "answer", arguments: {}, turn: "m1", at: 3 }
    ]
    expect(usedOf(log)).toBe(1)
  })

  test("budgetPhase reads the most recent marker", () => {
    expect(budgetPhase(turn(2, 5))).toBe("spending")
    expect(budgetPhase(turn(3, 2, [exhausted]))).toBe("exhausted")
    expect(budgetPhase(turn(3, 2, [exhausted, granted(5)]))).toBe("spending")
    expect(budgetPhase(turn(3, 2, [exhausted, denied]))).toBe("denied")
  })

  test("a grant raises the ceiling, so budgetOf grows and the machine reopens", () => {
    const log = turn(3, 2, [exhausted, granted(5)])
    expect(budgetOf(log)).toBe(7) // base 2 + grant 5
    expect(budgetReactor(log)).toHaveLength(0)
    // execute is offered again after a grant; withdrawn after exhaustion and after a denial.
    expect(budgetSpent(turn(3, 2, [exhausted]))).toBe(true)
    expect(budgetSpent(log)).toBe(false)
    expect(budgetSpent(turn(3, 2, [exhausted, denied]))).toBe(true)
  })

  test("the ask is offered only when escalatable and only at the wall", () => {
    const head = (escalatable: boolean): Event => ({ type: "MessageReceived", id: "m1", text: "go", budget: 2, escalatable, at: 0 })
    const atWall = (escalatable: boolean): Event[] => [head(escalatable), ...turn(3, 2, [exhausted]).slice(1)]
    expect(canRequestBudget(atWall(true))).toBe(true)
    expect(canRequestBudget(atWall(false))).toBe(false) // not escalatable: no ask
    const afterDenial = [head(true), ...turn(3, 2, [exhausted, denied]).slice(1)]
    expect(canRequestBudget(afterDenial)).toBe(false) // denied: answer, do not ask again
  })
})
