import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Envelope } from "@flamecast/core"
import {
  createAgent,
  defaultPack,
  inferWith,
  keyOf,
  type Action,
  type AgentServices,
  type Infer,
  type InferenceOptions,
  type ModelRequest,
  type NativeTool
} from "@flamecast/harness"
import { MemoryRuntime } from "@flamecast/runtime-memory"
import { divergence, rollout } from "./rollout"

const scripted = (actions: ReadonlyArray<Action>) => {
  const seen: Array<ModelRequest> = []
  return {
    seen,
    layer: inferWith(async (request) => {
      seen.push(request)
      const next = actions[seen.length - 1]
      if (next === undefined) throw new Error(`the stub model ran out of actions after ${seen.length}`)
      return next
    })
  }
}

const refuses = inferWith(async () => {
  throw new Error("the model was called on a step the recording already answered")
})

const usage = { promptTokens: 1284, completionTokens: 96, costUsd: 0.0041 }
const SYSTEM = "Use the tools for any question about an order."

const lookupInvoice: NativeTool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice by its order id.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"]
    }
  },
  run: () => Effect.succeed({ invoice: "INV-4182", total: "312.00" })
}

const LEDGER = "ledger line ".repeat(75)

const fetchLedger: NativeTool = {
  spec: { name: "fetch_ledger", description: "Read the ledger for one account.", inputSchema: {} },
  run: () => Effect.succeed({ lines: LEDGER })
}

const buildAgent = (
  inferenceOptions: InferenceOptions = {},
  toolList: ReadonlyArray<NativeTool> = [lookupInvoice, fetchLedger]
) =>
  createAgent({
    modules: defaultPack({
      inference: { system: SYSTEM, ...inferenceOptions },
      nativeTools: toolList
    })
  })

const agent = buildAgent()

const script: ReadonlyArray<Action> = [
  { kind: "call", callId: "c-01", name: "lookup_invoice", arguments: { orderId: "4182" }, usage },
  { kind: "call", callId: "c-02", name: "fetch_ledger", arguments: {}, usage },
  { kind: "complete", output: "Invoice INV-4182 totals 312.00.", usage }
]

const run = <A>(
  program: Effect.Effect<A, never, AgentServices>,
  model: Layer.Layer<Infer>,
  seed?: ReadonlyArray<Envelope>
) =>
  Effect.runPromise(
    Effect.provide(
      program,
      Layer.merge(
        MemoryRuntime({ keyOf, session: "user-42", ...(seed === undefined ? {} : { seed }) }),
        model
      )
    )
  )

const record = async () => {
  const model = scripted(script)
  return await run(
    Effect.gen(function* () {
      yield* agent.turn({ id: "m-1", text: "What does order 4182 owe?" })
      return yield* agent.log
    }),
    model.layer
  )
}

const types = (log: ReadonlyArray<Envelope>) => log.map((event) => event.type)

describe("a recorded turn", () => {
  test("has three model calls and a terminal", async () => {
    expect(types(await record())).toEqual([
      "MessageReceived",
      "ModelCalled",
      "ModelReturned",
      "ToolCalled",
      "ToolReturned",
      "ModelCalled",
      "ModelReturned",
      "ToolCalled",
      "ToolReturned",
      "ModelCalled",
      "ModelReturned",
      "TurnCompleted",
      "ReplyDelivered"
    ])
  })

  test("re-derives the request behind every recorded mark", async () => {
    const model = scripted(script)
    const recorded = await run(
      Effect.gen(function* () {
        yield* agent.turn({ id: "m-1", text: "What does order 4182 owe?" })
        return yield* agent.log
      }),
      model.layer
    )
    const marks = recorded.flatMap((event, index) => (event.type === "ModelCalled" ? [index] : []))
    for (const [step, at] of marks.entries()) {
      expect(agent.request(recorded.slice(0, at))).toEqual(model.seen[step]!)
    }
  })
})

describe("forked rollouts", () => {
  test("replays every equivalent step without a model call", async () => {
    const recorded = await record()
    const result = await run(
      rollout({ baseline: agent, candidate: buildAgent(), log: recorded }),
      refuses
    )
    expect(result.replayed).toBe(3)
    expect(result.called).toBe(0)
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 })
    expect(result.log).toEqual(recorded)
  })

  test("runs live from the first changed prompt", async () => {
    const recorded = await record()
    const candidate = buildAgent({ system: "Answer in one sentence." })
    const model = scripted(script)
    const result = await run(rollout({ baseline: agent, candidate, log: recorded }), model.layer)
    expect(result.replayed).toBe(0)
    expect(result.called).toBe(3)
    expect(model.seen[0]?.system).toBe("Answer in one sentence.")
    expect(result.usage.costUsd).toBeCloseTo(0.0123, 6)
    expect(types(result.log)).toEqual(types(recorded))
  })

  test("reuses the prefix before a late truncation divergence", async () => {
    const recorded = await record()
    const candidate = buildAgent({ resultTruncateAt: 500 })
    const model = scripted([{ kind: "complete", output: "The ledger is long.", usage }])
    const result = await run(rollout({ baseline: agent, candidate, log: recorded }), model.layer)
    expect(result.replayed).toBe(2)
    expect(result.called).toBe(1)
    expect(String(model.seen[0]?.messages.at(-1)?.content)).toContain("[truncated")
    expect(result.log.slice(0, 9)).toEqual(recorded.slice(0, 9))
    expect(result.log.at(-2)?.output).toBe("The ledger is long.")
  })

  test("keeps earlier tool results when divergence lands in the middle", async () => {
    const recorded = await record()
    const candidate = buildAgent({ resultTruncateAt: 20 })
    const model = scripted([
      { kind: "call", callId: "c-77", name: "fetch_ledger", arguments: {}, usage },
      { kind: "complete", output: "The ledger is long.", usage }
    ])
    const result = await run(rollout({ baseline: agent, candidate, log: recorded }), model.layer)
    expect(result.replayed).toBe(1)
    expect(result.called).toBe(2)
    const calls = result.log.filter((event) => event.type === "ToolCalled")
    expect(calls.map((event) => event.name)).toEqual(["lookup_invoice", "fetch_ledger"])
    expect(calls[1]?.callId).toBe("c-77")
  })

  test("replays code changes that preserve every rendered request", async () => {
    const recorded = await record()
    const candidate = buildAgent({ giveUpAfter: 5 })
    const result = await run(rollout({ baseline: agent, candidate, log: recorded }), refuses)
    expect(candidate.program.id).not.toBe(agent.program.id)
    expect(result.replayed).toBe(3)
    expect(result.called).toBe(0)
  })

  test("detects a code-owned tool description change", async () => {
    const recorded = await record()
    const revised = {
      ...lookupInvoice,
      spec: {
        ...lookupInvoice.spec,
        description: "Look up an invoice. Call it once per order."
      }
    }
    const candidate = buildAgent({}, [revised, fetchLedger])
    const model = scripted(script)
    const result = await run(rollout({ baseline: agent, candidate, log: recorded }), model.layer)
    expect(result.replayed).toBe(0)
    expect(result.called).toBe(3)
    expect(model.seen[0]?.tools[0]?.description).toBe(revised.spec.description)
  })

  test("does not write into the recorded session", async () => {
    const recorded = await record()
    const candidate = buildAgent({ system: "Answer in one sentence." })
    const model = scripted(script)
    const after = await run(
      Effect.gen(function* () {
        yield* rollout({ baseline: agent, candidate, log: recorded })
        return yield* agent.log
      }),
      model.layer,
      recorded
    )
    expect(after).toEqual(recorded)
  })

  test("is reusable and handles empty recordings", async () => {
    const recorded = await record()
    const once = rollout({ baseline: agent, candidate: buildAgent(), log: recorded })
    expect((await run(once, refuses)).log).toEqual(recorded)
    expect((await run(once, refuses)).log).toEqual(recorded)
    expect(await run(rollout({ baseline: agent, candidate: buildAgent(), log: [] }), refuses)).toEqual({
      replayed: 0,
      called: 0,
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      log: []
    })
  })

  test("does not reuse a recording from another program", async () => {
    const recorded = await record()
    const foreign = recorded.map((event, index) =>
      index === 0 ? { ...event, program: "git:foreign" } : event
    )
    const model = scripted(script)
    const result = await run(
      rollout({ baseline: agent, candidate: buildAgent(), log: foreign }),
      model.layer
    )
    expect(result.replayed).toBe(0)
    expect(result.called).toBe(3)
  })
})

describe("the pure divergence guard", () => {
  test("finds the first changed model request", async () => {
    const recorded = await record()
    expect(divergence(agent, buildAgent(), recorded)).toEqual({
      replayed: 3,
      upTo: recorded.length
    })
    expect(divergence(agent, buildAgent({ resultTruncateAt: 500 }), recorded)).toEqual({
      replayed: 2,
      upTo: 9
    })
    expect(divergence(agent, buildAgent({ system: "Be brief." }), recorded)).toEqual({
      replayed: 0,
      upTo: 1
    })
  })

  test("has no divergence point when the log has no model call", () => {
    const log: ReadonlyArray<Envelope> = [
      { type: "MessageReceived", id: "m-1", text: "hi", at: 1 }
    ]
    expect(divergence(agent, buildAgent(), log)).toEqual({ replayed: 0, upTo: 1 })
  })
})
