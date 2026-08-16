import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@flamecast/core"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import { Infer, inferWith, type Action, type NativeTool } from "./infer"
import { keyOf } from "./keys"
import { createAgent, type AgentServices } from "./module"
import { defaultPack } from "./pack"

// The dedup key policy, and the one property it has to keep: a key derived from an id the world
// supplies has to be namespaced by the scope that id is unique in. A provider numbers its tool
// calls per response, so `call_1` comes back on every turn, and a key of `tr:call_1` would make the
// store absorb the second turn's result as a redelivery of the first turn's.

const usage = { promptTokens: 10, completionTokens: 2, costUsd: 0.0001 }

const lookupInvoice: NativeTool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice by its order id.",
    inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] }
  },
  run: (input) =>
    Effect.succeed({ invoice: `INV-${(input as { orderId: string }).orderId}`, total: "312.00" })
}

const scripted = (actions: ReadonlyArray<Action>) => {
  let served = 0
  return inferWith(async () => {
    const next = actions[served]
    served += 1
    if (next === undefined) throw new Error(`the stub model ran out of actions after ${served}`)
    return next
  }, { contextWindow: 200_000 })
}

const run = <A>(program: Effect.Effect<A, never, AgentServices>, model: Layer.Layer<Infer>) =>
  Effect.runPromise(
    Effect.provide(program, Layer.merge(InMemoryRuntime({ keyOf, session: "user-42" }), model))
  )

describe("the key of an event the world supplies an id for", () => {
  test("a call id repeated on the next turn is a different key", () => {
    const first: Event = { type: "ToolReturned", turn: "m-1", callId: "call_1", result: 1 }
    const second: Event = { type: "ToolReturned", turn: "m-2", callId: "call_1", result: 2 }
    expect(keyOf(first)).not.toBe(keyOf(second))
  })

  test("every event keyed on a call id carries its turn", () => {
    const types = ["ToolReturned", "BudgetGranted", "BudgetDenied"]
    for (const type of types) {
      const one = keyOf({ type, turn: "m-1", callId: "c-1" })
      const two = keyOf({ type, turn: "m-2", callId: "c-1" })
      expect(one).toBeDefined()
      expect(one).not.toBe(two)
    }
  })

  test("the same id inside one turn still absorbs its redelivery", () => {
    const one = keyOf({ type: "ToolReturned", turn: "m-1", callId: "call_1", result: 1 })
    const two = keyOf({ type: "ToolReturned", turn: "m-1", callId: "call_1", result: 1 })
    expect(one).toBe(two)
  })

  test("a grant and denial for one request compete for one decision key", () => {
    const grant = keyOf({ type: "BudgetGranted", turn: "m-1", callId: "c-1", amount: 2 })
    const denial = keyOf({ type: "BudgetDenied", turn: "m-1", callId: "c-1" })
    expect(grant).toBe("bd:m-1/c-1")
    expect(denial).toBe(grant)
  })
})

describe("two turns whose model reuses one call id", () => {
  test("both tool results land and both turns complete", async () => {
    const agent = createAgent({ modules: defaultPack({ inference: { contextWindow: 200_000 }, nativeTools: [lookupInvoice] }) })
    // What a real provider does: tool calls are numbered per response, so turn 2 opens `call_1`
    // again. Nothing about the second call is a redelivery of the first.
    const model = scripted([
      { kind: "call", callId: "call_1", name: "lookup_invoice", arguments: { orderId: "4182" }, usage },
      { kind: "complete", output: "Invoice INV-4182 totals 312.00.", usage },
      { kind: "call", callId: "call_1", name: "lookup_invoice", arguments: { orderId: "4190" }, usage },
      { kind: "complete", output: "Invoice INV-4190 totals 312.00.", usage }
    ])

    const { first, second, log } = await run(
      Effect.gen(function* () {
        const first = yield* agent.turn({ id: "m-1", text: "Find the invoice for order 4182." })
        const second = yield* agent.turn({ id: "m-2", text: "And order 4190?" })
        return { first, second, log: yield* agent.log }
      }),
      model
    )

    expect(first).toMatchObject({ kind: "completed", output: "Invoice INV-4182 totals 312.00." })
    expect(second).toMatchObject({ kind: "completed", output: "Invoice INV-4190 totals 312.00." })
    const returned = log.filter((event) => event.type === "ToolReturned")
    expect(returned.map((event) => event.turn)).toEqual(["m-1", "m-2"])
    expect(returned.map((event) => event.result)).toEqual([
      { invoice: "INV-4182", total: "312.00" },
      { invoice: "INV-4190", total: "312.00" }
    ])
    expect(log.filter((event) => event.type === "TurnCompleted")).toHaveLength(2)
  })
})
