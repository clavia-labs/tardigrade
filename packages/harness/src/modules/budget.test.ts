import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@flamecast/core"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import { boundaryOf } from "../boundary"
import { inferWith, type Action, type ModelRequest, type NativeTool } from "../infer"
import { keyOf } from "../keys"
import { createAgent } from "../module"
import { defaultPack } from "../pack"
import {
  budgetOf,
  budgetPhase,
  budgetSpent,
  canRequestBudget,
  toolCallsOf,
  usedOf
} from "./budget"

const usage = { promptTokens: 10, completionTokens: 2, costUsd: 0.0001 }

const lookup: NativeTool = {
  spec: { name: "lookup_invoice", description: "Look one up.", inputSchema: {} },
  run: () => Effect.succeed({ invoice: "INV-4182" })
}

const scripted = (actions: ReadonlyArray<Action>) => {
  const seen: Array<ModelRequest> = []
  return {
    seen,
    layer: inferWith(async (request) => {
      seen.push(request)
      const next = actions[seen.length - 1]
      if (next === undefined) throw new Error(`the stub model ran out of actions after ${seen.length}`)
      return next
    }, { contextWindow: 200_000 })
  }
}

const call = (callId: string): Action => ({
  kind: "call",
  callId,
  name: "lookup_invoice",
  arguments: { orderId: "4182" },
  usage
})

const agent = createAgent({ modules: defaultPack({ inference: { contextWindow: 200_000 }, nativeTools: [lookup] }) })

const head = (over: Record<string, unknown> = {}): Event => ({
  type: "MessageReceived",
  id: "m-1",
  text: "Find order 4182.",
  at: 1,
  ...over
})

const called = (callId: string, name = "lookup_invoice"): Event => ({
  type: "ToolCalled",
  turn: "m-1",
  callId,
  name,
  arguments: {},
  at: 2
})

describe("the budget projections", () => {
  test("a turn with no declared budget takes the default", () => {
    expect(budgetOf([head()])).toBe(40)
  })

  test("the head event stores the budget", () => {
    expect(budgetOf([head({ budget: 3 })])).toBe(3)
  })

  test("a grant raises the ceiling", () => {
    const log = [head({ budget: 3 }), { type: "BudgetGranted", turn: "m-1", amount: 2, at: 3 }]
    expect(budgetOf(log)).toBe(5)
  })

  test("only work draws the budget down", () => {
    const log = [head(), called("c-1"), called("c-2", "answer"), called("c-3", "request-budget")]
    expect(usedOf(log)).toBe(1)
  })

  test("work can be counted across turns", () => {
    const log: ReadonlyArray<Event> = [
      head(),
      called("c-1"),
      { type: "TurnCompleted", turn: "m-1", output: "done", at: 3 },
      { type: "MessageReceived", id: "m-2", text: "next", at: 4 },
      { type: "ToolCalled", turn: "m-2", callId: "c-2", name: "lookup_invoice", arguments: {}, at: 5 },
      { type: "ToolCalled", turn: "m-2", callId: "c-3", name: "answer", arguments: {}, at: 6 }
    ]
    expect(toolCallsOf(log)).toBe(2)
  })

  test("the phase is scoped to the turn, so an earlier wall does not leak", () => {
    const log: ReadonlyArray<Event> = [
      head(),
      { type: "BudgetExhausted", turn: "m-1", budget: 1, used: 2, at: 3 },
      { type: "TurnCompleted", turn: "m-1", output: "done", at: 4 },
      { type: "MessageReceived", id: "m-2", text: "next", at: 5 }
    ]
    expect(budgetPhase(log)).toBe("spending")
    expect(budgetSpent(log)).toBe(false)
  })

  test("an escalation is offered only to a turn whose head allows it", () => {
    const wall = { type: "BudgetExhausted", turn: "m-1", budget: 1, used: 2, at: 3 }
    expect(canRequestBudget([head(), wall])).toBe(false)
    expect(canRequestBudget([head({ escalatable: true }), wall])).toBe(true)
  })

  test("a denial closes the ask and leaves the wall up", () => {
    const log: ReadonlyArray<Event> = [
      head({ escalatable: true }),
      { type: "BudgetExhausted", turn: "m-1", budget: 1, used: 2, at: 3 },
      { type: "BudgetDenied", turn: "m-1", at: 4 }
    ]
    expect(budgetSpent(log)).toBe(true)
    expect(canRequestBudget(log)).toBe(false)
  })
})

describe("the wall", () => {
  test("fires once and closes the tool surface", async () => {
    const model = scripted([call("c-1"), call("c-2"), { kind: "complete", output: "Partial.", usage }])
    const log = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* agent.turn({ id: "m-1", text: "Find order 4182.", budget: 1 })
          return yield* agent.log
        }),
        Layer.merge(InMemoryRuntime({ keyOf }), model.layer)
      )
    )

    const walls = log.filter((event) => event.type === "BudgetExhausted")
    expect(walls).toHaveLength(1)
    // Off by one on purpose: the turn gets its budget dispatched and the wall lands behind the
    // last return, which is what the documented transcript shows.
    expect(walls[0]).toMatchObject({ turn: "m-1", budget: 1, used: 2 })

    // The surface was open for the first two calls and closed for the third.
    expect(model.seen[0]?.tools.map((tool) => tool.name)).toEqual(["lookup_invoice"])
    expect(model.seen[2]?.tools).toEqual([])
    expect(model.seen[2]?.system).not.toContain("Your tool budget for this turn is spent")
    expect(model.seen[2]?.messages.at(-1)?.content).toContain(
      "Your tool budget for this turn is spent"
    )
  })

  test("refuses a dispatch after the wall, so the log and the surface agree", async () => {
    // The model ignores the withdrawn surface and calls the tool anyway.
    const model = scripted([
      call("c-1"),
      call("c-2"),
      call("c-3"),
      { kind: "complete", output: "Partial.", usage }
    ])
    const log = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* agent.turn({ id: "m-1", text: "Find order 4182.", budget: 1 })
          return yield* agent.log
        }),
        Layer.merge(InMemoryRuntime({ keyOf }), model.layer)
      )
    )
    const refused = log.filter((event) => event.type === "ToolReturned").at(-1)
    expect(String(refused?.error)).toContain("Tool budget reached")
  })
})

describe("the escalation", () => {
  test("parks on an ask and resumes on a grant", async () => {
    const model = scripted([
      call("c-1"),
      call("c-2"),
      {
        kind: "call",
        callId: "c-3",
        name: "request-budget",
        arguments: { reason: "two invoices left", amount: 2 },
        usage
      },
      call("c-4"),
      { kind: "complete", output: "All three invoices are in.", usage }
    ])
    const layer = Layer.merge(InMemoryRuntime({ keyOf }), model.layer)

    const parked = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const result = yield* agent.turn({
            id: "m-1",
            text: "Find every invoice.",
            budget: 1,
            escalatable: true
          })
          return { result, log: yield* agent.log }
        }),
        layer
      )
    )

    // A park is not a terminal: the turn holds no lock and no fiber waits.
    expect(parked.result).toMatchObject({
      kind: "parked",
      callId: "c-3",
      reason: "two invoices left",
      amount: 2
    })
    expect(boundaryOf(parked.log, "m-1")).toEqual({
      kind: "parked",
      callId: "c-3",
      reason: "two invoices left",
      amount: 2
    })
    // The escalate nudge offered the ask exactly at the wall.
    expect(model.seen[2]?.tools.map((tool) => tool.name)).toEqual(["request-budget"])

    const resumed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const result = yield* agent.replay([
            { type: "BudgetGranted", turn: "m-1", amount: 2, at: 99 }
          ])
          return { result, log: yield* agent.log }
        }),
        layer
      )
    )

    expect(resumed.result).toMatchObject({ kind: "completed", output: "All three invoices are in." })

    // The grant answered the ask as a tool result, so the model loop woke on it.
    const answered = resumed.log.find(
      (event) => event.type === "ToolReturned" && event.callId === "c-3"
    )
    expect(answered?.result).toEqual({ granted: 2 })
    // A grant reopened the surface.
    expect(model.seen[3]?.tools.map((tool) => tool.name)).toEqual(["lookup_invoice"])
  })

  test("a denial answers the ask and the turn finishes", async () => {
    const model = scripted([
      call("c-1"),
      call("c-2"),
      {
        kind: "call",
        callId: "c-3",
        name: "request-budget",
        arguments: { reason: "more please", amount: 5 },
        usage
      },
      { kind: "complete", output: "Here is what I have.", usage }
    ])
    const layer = Layer.merge(InMemoryRuntime({ keyOf }), model.layer)

    await Effect.runPromise(
      Effect.provide(
        agent.turn({ id: "m-1", text: "Find every invoice.", budget: 1, escalatable: true }),
        layer
      )
    )
    const resumed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const result = yield* agent.replay([
            { type: "BudgetDenied", turn: "m-1", reason: "the pool is empty", at: 99 }
          ])
          return { result, log: yield* agent.log }
        }),
        layer
      )
    )
    expect(resumed.result).toMatchObject({ kind: "completed", output: "Here is what I have." })
    const answered = resumed.log.find(
      (event) => event.type === "ToolReturned" && event.callId === "c-3"
    )
    expect(answered?.result).toMatchObject({ denied: true, reason: "the pool is empty" })
    // A denied turn answers; it does not ask again.
    expect(model.seen[3]?.tools).toEqual([])
  })

  test("a message queued behind a parked turn reports its turn as open", async () => {
    const model = scripted([
      call("c-1"),
      call("c-2"),
      {
        kind: "call",
        callId: "c-3",
        name: "request-budget",
        arguments: { reason: "one more", amount: 1 },
        usage
      }
    ])
    const layer = Layer.merge(InMemoryRuntime({ keyOf }), model.layer)

    const outcomes = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const parked = yield* agent.turn({
            id: "m-1",
            text: "Find every invoice.",
            budget: 1,
            escalatable: true
          })
          // m-1 is parked, so the fold still serves m-1 and m-2 waits committed and unserved.
          // Its turn has neither ended nor parked, and that is the fourth outcome: a park
          // reported as an ending would lie, and so would an ending reported for a turn that
          // has not started.
          const queued = yield* agent.turn({ id: "m-2", text: "And order 4190?" })
          return { parked, queued, log: yield* agent.log }
        }),
        layer
      )
    )

    expect(outcomes.parked.kind).toBe("parked")
    expect(outcomes.queued).toMatchObject({ kind: "open", turn: "m-2" })
    // The queued message is committed, and nothing was served for it.
    expect(outcomes.log.filter((event) => event.type === "MessageReceived")).toHaveLength(2)
    expect(outcomes.log.filter((event) => event.turn === "m-2")).toEqual([])
  })
})
