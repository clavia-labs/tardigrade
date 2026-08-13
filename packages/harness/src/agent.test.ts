import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { conformance, type Envelope } from "@flamecast/core"
import { MemoryRuntime } from "@flamecast/runtime-memory"
import { Infer, inferWith, type Action, type ModelRequest, type Tool } from "./infer"
import { keyOf } from "./keys"
import { createAgent, undeclaredEvents, type AgentServices } from "./module"
import { defaultPack } from "./pack"
import { inference } from "./modules/inference"

// The end to end proof: the documented agents run against the memory runtime with a stub model, the
// log is exactly the documented one, and a replay of that log calls nothing.

const scripted = (actions: ReadonlyArray<Action>) => {
  const seen: Array<ModelRequest> = []
  const keys: Array<string> = []
  return {
    seen,
    keys,
    layer: inferWith(async (request, key) => {
      seen.push(request)
      keys.push(key)
      const next = actions[seen.length - 1]
      if (next === undefined) throw new Error(`the stub model ran out of actions after ${seen.length}`)
      return next
    })
  }
}

const refuses = inferWith(async () => {
  throw new Error("the model was called when the record already held the answer")
})

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

const usage = { promptTokens: 1284, completionTokens: 96, costUsd: 0.0041 }

const lookupInvoice: Tool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice by its order id. Returns the total and the status.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"]
    }
  },
  run: (input) =>
    Effect.succeed({ invoice: `INV-${(input as { orderId: string }).orderId}`, total: "312.00" })
}

describe("the smallest agent", () => {
  test("one module, one turn, the documented log", async () => {
    const agent = createAgent({
      modules: [inference({ system: "You are a support agent. Answer in plain text." })]
    })
    const model = scripted([{ kind: "complete", output: "We are open 9 to 5.", usage }])

    const { result, log } = await run(
      Effect.gen(function* () {
        const result = yield* agent.turn({ id: "m-1", text: "What are your support hours?" })
        const log = yield* agent.log
        return { result, log }
      }),
      model.layer
    )

    expect(log.map((event) => event.type)).toEqual([
      "MessageReceived",
      "ModelCalled",
      "ModelReturned",
      "TurnCompleted",
      "ReplyDelivered"
    ])
    expect(result).toMatchObject({ kind: "completed", output: "We are open 9 to 5.", turn: "m-1" })
    expect(result.usage).toEqual(usage)
    // The turn pins the program that ran it, so a replay can verify provenance.
    expect(log[0]?.program).toBe(agent.program.id)
    expect(model.seen[0]?.system).toBe("You are a support agent. Answer in plain text.")
    expect(model.seen[0]?.messages).toEqual([
      { role: "user", content: "What are your support hours?" }
    ])
  })
})

describe("a turn with tools", () => {
  const agent = createAgent({
    modules: defaultPack({
      inference: { system: "Use lookup_invoice for any question about an order." },
      tools: [lookupInvoice]
    })
  })

  const script: ReadonlyArray<Action> = [
    {
      kind: "call",
      callId: "c-02",
      name: "lookup_invoice",
      arguments: { orderId: "4182" },
      text: "Looking it up.",
      usage
    },
    { kind: "complete", output: "Invoice INV-4182 totals 312.00.", usage }
  ]

  test("dispatches the call, records both halves, and answers", async () => {
    const model = scripted(script)
    const { result, log } = await run(
      Effect.gen(function* () {
        const result = yield* agent.turn({ id: "m-1", text: "Find the invoice for order 4182." })
        return { result, log: yield* agent.log }
      }),
      model.layer
    )

    expect(log.map((event) => event.type)).toEqual([
      "MessageReceived",
      "ModelCalled",
      "ModelReturned",
      "TextReturned",
      "ToolCalled",
      "ToolReturned",
      "ModelCalled",
      "ModelReturned",
      "TurnCompleted",
      "ReplyDelivered"
    ])
    expect(result).toMatchObject({ kind: "completed", output: "Invoice INV-4182 totals 312.00." })
    // The whole turn's spend, not one call's.
    expect(result.usage.costUsd).toBeCloseTo(0.0082, 6)
    // Both halves carry the callId, so the pair survives a crash between them.
    const called = log.find((event) => event.type === "ToolCalled")
    const returned = log.find((event) => event.type === "ToolReturned")
    expect(called?.callId).toBe("c-02")
    expect(returned?.callId).toBe("c-02")
    expect(returned?.result).toEqual({ invoice: "INV-4182", total: "312.00" })
    // Every event names the turn it served.
    expect(log.slice(1).every((event) => event.turn === "m-1")).toBe(true)
  })

  test("the second call reads the tool result the first one produced", async () => {
    const model = scripted(script)
    await run(agent.turn({ id: "m-1", text: "Find the invoice for order 4182." }), model.layer)

    expect(model.seen[0]?.tools.map((tool) => tool.name)).toEqual(["lookup_invoice"])
    expect(model.seen[1]?.messages).toEqual([
      { role: "user", content: "Find the invoice for order 4182." },
      {
        role: "assistant",
        content: "Looking it up.",
        toolCalls: [{ id: "c-02", name: "lookup_invoice", arguments: '{"orderId":"4182"}' }]
      },
      {
        role: "tool",
        toolCallId: "c-02",
        content: '{"invoice":"INV-4182","total":"312.00"}'
      }
    ])
    // One key per logical attempt, so a provider that dedups collapses a retried one.
    expect(model.keys).toEqual(["m-1/infer/0", "m-1/infer/1"])
  })

  test("replays the stored log with no model call", async () => {
    const model = scripted(script)
    const recorded = await run(
      Effect.gen(function* () {
        yield* agent.turn({ id: "m-1", text: "Find the invoice for order 4182." })
        return yield* agent.log
      }),
      model.layer
    )

    const replayed = await run(
      Effect.gen(function* () {
        const result = yield* agent.replay(recorded)
        return { result, log: yield* agent.log }
      }),
      refuses
    )

    expect(replayed.result).toMatchObject({ kind: "completed", output: "Invoice INV-4182 totals 312.00." })
    // Replay is re-folding: nothing new lands, because every act committed its outcome.
    expect(replayed.log.map((event) => event.type)).toEqual(
      recorded.map((event) => event.type)
    )
  })

  test("forks a session into an independent in-memory branch", async () => {
    const model = scripted([...script, ...script])
    const result = await run(
      Effect.gen(function* () {
        yield* agent.turn({ id: "m-1", text: "Find the invoice for order 4182." })
        const before = yield* agent.log
        const fork = yield* agent.fork({ at: 1, id: "alternate" })
        yield* fork.replay([])
        return { before, after: yield* agent.log, fork: yield* fork.log }
      }),
      model.layer
    )
    expect(result.after).toEqual(result.before)
    expect(result.fork[0]).toEqual(result.before[0])
    expect(result.fork.map((event) => event.type)).toEqual(
      result.before.map((event) => event.type)
    )
  })

  test("a candidate program renders differently over the same record", async () => {
    const model = scripted(script)
    const recorded = await run(
      Effect.gen(function* () {
        yield* agent.turn({ id: "m-1", text: "Find the invoice for order 4182." })
        return yield* agent.log
      }),
      model.layer
    )

    const candidate = createAgent({
      parent: agent.program.id,
      modules: defaultPack({
        inference: { system: "Answer in one sentence." },
        tools: [lookupInvoice]
      })
    })
    const after = scripted(script)
    await run(
      Effect.gen(function* () {
        yield* candidate.replay(recorded.slice(0, 1))
      }),
      after.layer
    )
    expect(after.seen[0]?.system).toBe("Answer in one sentence.")
    expect(model.seen[0]?.system).toBe("Use lookup_invoice for any question about an order.")
  })

  test("the machines pass the conformance kit against the recorded run", async () => {
    const model = scripted(script)
    const recorded = await run(
      Effect.gen(function* () {
        yield* agent.turn({ id: "m-1", text: "Find the invoice for order 4182." })
        return yield* agent.log
      }),
      model.layer
    )

    const report = await Effect.runPromise(
      conformance({ machines: agent.program.machines, logs: [recorded], keyOf })
    )
    expect(report.purity.failures).toEqual([])
    expect(report.idempotence.failures).toEqual([])
    expect(report.wedge.failures).toEqual([])
    expect(report.dedup.failures).toEqual([])
    expect(report.ok).toBe(true)
  })

  test("every event the run emitted is declared by a module", async () => {
    const model = scripted(script)
    const recorded = await run(
      Effect.gen(function* () {
        yield* agent.turn({ id: "m-1", text: "Find the invoice for order 4182." })
        return yield* agent.log
      }),
      model.layer
    )

    // `Module.events` is what an optimizer and an exporter work against, so it has to be a
    // contract rather than a comment. A module that emits an event it never declared shows up
    // here as a name.
    expect(undeclaredEvents(agent.program, recorded)).toEqual([])
  })

  test("a redelivered message opens no second turn", async () => {
    const model = scripted(script)
    const log = await run(
      Effect.gen(function* () {
        yield* agent.turn({ id: "m-1", text: "Find the invoice for order 4182." })
        yield* agent.turn({ id: "m-1", text: "Find the invoice for order 4182." })
        return yield* agent.log
      }),
      model.layer
    )
    expect(log.filter((event) => event.type === "MessageReceived")).toHaveLength(1)
    expect(model.seen).toHaveLength(2)
  })

  test("a tool that dies returns the error to the model", async () => {
    const broken: Tool = {
      spec: { name: "lookup_invoice", description: "Look one up.", inputSchema: {} },
      run: () => Effect.die(new Error("the invoice service is down"))
    }
    const withBroken = createAgent({ modules: defaultPack({ tools: [broken] }) })
    const model = scripted(script)
    const log = await run(
      Effect.gen(function* () {
        yield* withBroken.turn({ id: "m-1", text: "Find order 4182." })
        return yield* withBroken.log
      }),
      model.layer
    )
    const returned = log.find((event) => event.type === "ToolReturned")
    expect(String(returned?.error)).toContain("the invoice service is down")
    // The tool died and the turn did not.
    expect(log.some((event) => event.type === "TurnFailed")).toBe(false)
  })

  test("a hallucinated tool costs one round trip, not a stalled turn", async () => {
    const model = scripted([
      { kind: "call", callId: "c-1", name: "no_such_tool", arguments: {}, usage },
      { kind: "complete", output: "I could not do that.", usage }
    ])
    const log = await run(
      Effect.gen(function* () {
        yield* agent.turn({ id: "m-1", text: "Do something impossible." })
        return yield* agent.log
      }),
      model.layer
    )
    const returned = log.find((event) => event.type === "ToolReturned")
    expect(returned?.error).toBe("unknown tool: no_such_tool")
    expect(log.some((event) => event.type === "TurnCompleted")).toBe(true)
  })
})

describe("the give-up policy", () => {
  test("a turn that keeps dying fails instead of trying forever", async () => {
    const agent = createAgent({ modules: [inference()] })
    const model = scripted([{ kind: "fail", error: "the provider refused", usage }])
    const result = await run(
      agent.turn({ id: "m-1", text: "hello" }),
      model.layer
    )
    // The union states the outcome, so no caller has to read an absent field to learn it failed.
    expect(result).toMatchObject({ kind: "failed", error: "the provider refused" })
  })

  test("three marks with nothing after them end the turn", async () => {
    const agent = createAgent({ modules: [inference()] })
    // A log whose last three events are attempts that died: the model call never landed a
    // consequence. Replay reads that as the crash loop it is.
    const seeded: ReadonlyArray<Envelope> = [
      { type: "MessageReceived", id: "m-1", text: "hello", at: 1 },
      { type: "ModelCalled", turn: "m-1", callId: "m-1/infer/0", at: 2 },
      { type: "ModelCalled", turn: "m-1", callId: "m-1/infer/0", at: 3 },
      { type: "ModelCalled", turn: "m-1", callId: "m-1/infer/0", at: 4 }
    ]
    const result = await run(agent.replay(seeded), refuses)
    expect(result).toMatchObject({ kind: "failed", error: "the model attempt died 3 times in a row" })
  })
})
