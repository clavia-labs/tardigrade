import { expect, test } from "bun:test"
import fc from "fast-check"
import { component, withResponse } from "@clavia/tardigrade-core/actor"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"
import { replayState } from "@clavia/tardigrade-core/projection"
import type { TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { testMachineOf } from "../../../fixtures/component"
import { AGENT_VIEW_ALGEBRA } from "../view"
import { budget } from "./index"

const workload = (accounting: "request" | "admission") =>
  component({
    name: "work",
    initial: () => ({
      used: 0,
      revision: 0,
      pending: [] as ReadonlyArray<{ id: number; cost: number; context: TransitionContext }>
    }),
    step: (state, event, context) => {
      if (event.type === "MessageReceived") return { used: 0, revision: 0, pending: [] }
      if (event.type === "Requested")
        return {
          ...state,
          used: state.used + (accounting === "request" ? Number(event.cost) : 0),
          pending: [...state.pending, { id: Number(event.id), cost: Number(event.cost), context }]
        }
      if (event.type === "Executed" || event.type === "Refused")
        return {
          ...state,
          used: state.used + (accounting === "admission" && event.type === "Executed" ? Number(event.cost) : 0),
          pending: state.pending.filter((request) => request.id !== event.id)
        }
      return event.type === "Refresh" ? { ...state, revision: state.revision + 1 } : state
    },
    output: (state) => ({
      view: { ...AGENT_VIEW_ALGEBRA.empty, measured: state.used, pending: state.pending.map(({ id }) => id) },
      transitions: state.pending.map(({ id, cost, context }) =>
        withResponse(
          context.intent(`execute/${state.revision}`, { type: "Executed", id, cost }),
          (result: { error: string }) => context.intent("refuse", { type: "Refused", id, result })
        )
      )
    })
  })

const setup = (accounting: "request" | "admission", limit: number) => {
  const machine = testMachineOf(
    budget(workload(accounting), {
      limit,
      usage: ({ measured }) => measured,
      onExhausted: (reason, respond) => respond({ error: reason })
    })
  )
  const log: Event[] = []
  let state = machine.initial()
  const append = (event: Event) => {
    log.push(event)
    state = machine.step(state, eventAt(event, log.length))
  }
  const output = () => machine.output(state)
  const proposed = () =>
    output().transitions.flatMap((work) => {
      if (work.kind !== "intent") throw new Error("fixture proposes only intents")
      return work.events(work.input, 0)
    })
  const checkReplay = () => {
    const restored = machine.output(replayState(machine, log))
    expect(restored.view).toEqual(output().view)
    expect(restored.transitions.map((work) => work.key)).toEqual(output().transitions.map((work) => work.key))
  }
  const drain = (requests: number) => {
    for (let step = 0; step <= requests * 2 + 1; step++) {
      const next = proposed()[0]
      if (next === undefined) break
      append(next)
      checkReplay()
    }
    expect(output().transitions).toEqual([])
  }
  append({ type: "MessageReceived", id: "turn", text: "work" })
  append({ type: "BudgetGranted", initial: true, amount: limit, turn: "turn" })
  return { append, output, proposed, checkReplay, drain, log }
}

for (const accounting of ["request", "admission"] as const) {
  test(`${accounting}: ordered requests admit exactly the affordable work and settle every refusal`, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 15 }),
        (limit, costs) => {
          const fixture = setup(accounting, limit)
          let remaining = limit
          const expected = costs.map((cost, id) => {
            const type = cost <= remaining ? "Executed" : "Refused"
            if (type === "Executed") remaining -= cost
            return { type, id }
          })
          costs.forEach((cost, id) => fixture.append({ type: "Requested", id, cost, turn: "turn" }))
          fixture.checkReplay()
          fixture.drain(costs.length)
          const outcomes = fixture.log
            .filter((event) => event.type === "Executed" || event.type === "Refused")
            .map((event) => ({ type: event.type, id: Number(event.id) }))
            .sort((a, b) => a.id - b.id)
          expect(outcomes).toEqual(expected)
          expect(fixture.output().view).toMatchObject({ used: limit - remaining, remaining })
          expect(fixture.output().view).toMatchObject({ pending: [] })
        }
      ),
      { numRuns: 100, includeErrorInReport: true }
    )
  })

  test(`${accounting}: committed refusal survives grants and regenerated proposals while new work can proceed`, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        fc.nat(5),
        (limit, excess, refreshes) => {
          const fixture = setup(accounting, limit)
          fixture.append({ type: "Requested", id: 0, cost: limit + excess, turn: "turn" })
          const walls = fixture.proposed().filter((event) => event.type === "BudgetExhausted")
          expect(walls.length).toBeGreaterThan(0)
          walls.forEach(fixture.append)
          fixture.append({ type: "BudgetGranted", amount: excess, turn: "turn" })
          for (let i = 0; i < refreshes; i++) fixture.append({ type: "Refresh" })
          fixture.checkReplay()
          expect(fixture.proposed()).toContainEqual(expect.objectContaining({ type: "Refused", id: 0 }))
          expect(fixture.proposed().some((event) => event.type === "Executed")).toBe(false)
          fixture.drain(1)
          expect(fixture.output().view).toMatchObject({ used: 0, remaining: limit + excess, pending: [] })
          fixture.append({ type: "Requested", id: 1, cost: limit + excess, turn: "turn" })
          fixture.drain(1)
          expect(fixture.log.filter((event) => event.type === "Executed").map((event) => event.id)).toEqual([1])
          expect(fixture.log.filter((event) => event.type === "Refused").map((event) => event.id)).toEqual([0])
          expect(fixture.output().view).toMatchObject({ used: limit + excess, remaining: 0, pending: [] })
          fixture.append({ type: "TurnCompleted", turn: "turn", output: "done" })
          fixture.append({ type: "MessageReceived", id: "next", text: "work", budget: limit })
          fixture.append({ type: "BudgetGranted", initial: true, amount: limit, turn: "next" })
          fixture.append({ type: "Requested", id: 2, cost: limit, turn: "next" })
          fixture.drain(1)
          expect(fixture.output().view).toMatchObject({ limit, used: limit, remaining: 0, pending: [] })
        }
      ),
      { numRuns: 100, includeErrorInReport: true }
    )
  })
}
