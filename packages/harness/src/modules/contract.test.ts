import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import { inferWith, type Action, type ModelRequest } from "../infer"
import { keyOf } from "../keys"
import { createAgent } from "../module"
import { defaultPack } from "../pack"
import { schemaErrors } from "../schema"

const usage = { promptTokens: 10, completionTokens: 2, costUsd: 0.0001 }

const schema = {
  type: "object",
  properties: {
    invoice: { type: "string" },
    lines: { type: "array", items: { type: "number" } }
  },
  required: ["invoice", "lines"],
  additionalProperties: false
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

const answer = (callId: string, args: unknown): Action => ({
  kind: "call",
  callId,
  name: "answer",
  arguments: args,
  usage
})

const agent = createAgent({ modules: defaultPack({ inference: { contextWindow: 200_000 } }) })

const runTurn = (model: ReturnType<typeof scripted>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const result = yield* agent.turn({
          id: "m-1",
          text: "Find the invoice for order 4182.",
          output: schema
        })
        return { result, log: yield* agent.log }
      }),
      Layer.merge(InMemoryRuntime({ keyOf }), model.layer)
    )
  )

describe("the answer check", () => {
  test("reports every missing required property at once", () => {
    expect(schemaErrors(schema, {})).toBe('Missing key\n  at ["invoice"]\nMissing key\n  at ["lines"]')
  })

  test("reports the shape the model actually got wrong", () => {
    // The failure this exists for: a nested array arriving as a stringified copy.
    expect(schemaErrors(schema, { invoice: "INV-1", lines: "[1,2]" })).toBe(
      'Expected array\n  at ["lines"]'
    )
  })

  test("reports an element of the wrong type inside an array", () => {
    expect(schemaErrors(schema, { invoice: "INV-1", lines: [1, "2"] })).toBe(
      'Expected number\n  at ["lines"][1]'
    )
  })

  test("reports a property the schema closed", () => {
    expect(schemaErrors(schema, { invoice: "INV-1", lines: [], extra: 1 })).toBe(
      'Expected no excess property\n  at ["extra"]'
    )
  })

  test("passes a conforming answer", () => {
    expect(schemaErrors(schema, { invoice: "INV-1", lines: [1, 2] })).toBeUndefined()
  })

  test("a turn that declares nothing has nothing to conform to", () => {
    expect(schemaErrors(undefined, { anything: true })).toBeUndefined()
  })

  // The schema reaches the check as the JSON the log carries, so a declaration that survives the
  // round trip checks the same way whether it was written here or arrived from another session.
  test("a schema this dialect can not express checks nothing rather than failing the turn", () => {
    expect(schemaErrors("not a schema", { anything: true })).toBeUndefined()
  })
})

describe("the contract in a turn", () => {
  test("offers the answer tool built from the declared schema", async () => {
    const model = scripted([answer("c-1", { invoice: "INV-4182", lines: [312] })])
    await runTurn(model)
    expect(model.seen[0]?.tools.map((tool) => tool.name)).toEqual(["answer"])
    expect(model.seen[0]?.tools[0]?.inputSchema).toEqual(schema)
    expect(model.seen[0]?.system).not.toContain("This turn declares an output schema")
    expect(model.seen[0]?.messages.at(-1)?.content).toContain(
      "This turn declares an output schema"
    )
  })

  test("a conforming answer ends the turn", async () => {
    const model = scripted([answer("c-1", { invoice: "INV-4182", lines: [312] })])
    const { result, log } = await runTurn(model)
    expect(result).toMatchObject({ kind: "completed", output: '{"invoice":"INV-4182","lines":[312]}' })
    expect(log.map((event) => event.type)).toEqual([
      "MessageReceived",
      "ModelCalled",
      "ModelReturned",
      "ToolCalled",
      "ToolReturned",
      "TurnCompleted",
      "ReplyDelivered"
    ])
    expect(log.some((event) => event.type === "AnswerRejected")).toBe(false)
  })

  test("a rejection comes back as a tool result and the model repairs it", async () => {
    const model = scripted([
      answer("c-1", { invoice: "INV-4182", lines: "[312]" }),
      answer("c-2", { invoice: "INV-4182", lines: [312] })
    ])
    const { result, log } = await runTurn(model)

    const rejected = log.filter((event) => event.type === "AnswerRejected")
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({
      turn: "m-1",
      callId: "c-1",
      error: 'Expected array\n  at ["lines"]'
    })
    // The model reads its own errors, which is what makes the repair possible.
    const repair = model.seen[1]?.messages.findLast((message) => message.role === "tool")
    expect(repair?.role).toBe("tool")
    const reported = JSON.parse(String(repair?.content)) as { readonly error: string }
    expect(reported.error).toContain("did not match this turn's output schema")
    expect(reported.error).toContain('Expected array\n  at ["lines"]')
    expect(result).toMatchObject({ kind: "completed", output: '{"invoice":"INV-4182","lines":[312]}' })
  })

  test("repairs are bounded, so a model that can not meet the schema fails by name", async () => {
    const bad = { invoice: "INV-4182", lines: "[312]" }
    const model = scripted([answer("c-1", bad), answer("c-2", bad), answer("c-3", bad)])
    const { result, log } = await runTurn(model)

    expect(log.filter((event) => event.type === "AnswerRejected")).toHaveLength(3)
    expect(result).toMatchObject({
      kind: "failed",
      error: "the answer did not satisfy the declared schema after 2 corrections"
    })
    // The bound is a policy, so the model was asked exactly three times and then not again.
    expect(model.seen).toHaveLength(3)
  })

  test("the inference module owns the repair bound", async () => {
    const patient = createAgent({
      modules: defaultPack({ inference: { repairAtMost: 0, contextWindow: 200_000 } })
    })
    const bad = { invoice: "INV-4182", lines: "[312]" }
    const model = scripted([answer("c-1", bad), answer("c-2", bad)])
    const result = await Effect.runPromise(
      Effect.provide(
        patient.turn({ id: "m-1", text: "Find it.", output: schema }),
        Layer.merge(InMemoryRuntime({ keyOf }), model.layer)
      )
    )
    expect(result).toMatchObject({
      kind: "failed",
      error: "the answer did not satisfy the declared schema after 0 corrections"
    })
    expect(model.seen).toHaveLength(1)
  })

  test("a turn that declares no schema is answered in prose", async () => {
    const model = scripted([{ kind: "complete", output: "We are open 9 to 5.", usage }])
    const result = await Effect.runPromise(
      Effect.provide(
        agent.turn({ id: "m-1", text: "What are your hours?" }),
        Layer.merge(InMemoryRuntime({ keyOf }), model.layer)
      )
    )
    expect(result).toMatchObject({ kind: "completed", output: "We are open 9 to 5." })
    expect(model.seen[0]?.tools).toEqual([])
  })
})
