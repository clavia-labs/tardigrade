import { expect, test } from "bun:test"
import fc from "fast-check"
import { Context, Effect, Layer } from "effect"
import { actor } from "@clavia/tardigrade-core/actor"
import { infer } from "../component/infer"
import { outputValidateOnce } from "../component/repair"
import { tool } from "../component/tool"
import { agentMessageMethod } from "../actor/message"
import { ActorCheckError, checkActor, replayActor, type ActorCheckContext } from "@clavia/tardigrade-core/testing"
import { testInferenceLayer } from "../../fixtures/model"
import type { InferRequest } from "../model/contract"
import type { Action } from "../log/events"

type GeneratedModelResponse = Extract<Action, { readonly kind: "calls" | "complete" }>

class Counter extends Context.Service<Counter, { readonly next: () => number }>()("check/Counter") {}
const definition = actor({
  name: "checked",
  methods: { message: agentMessageMethod },
  components: [infer([outputValidateOnce, tool({
    spec: { name: "count", description: "Count", inputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } },
    run: value => Effect.map(Counter, counter => ({ value, count: counter.next() })),
  })])],
})
const inputs = fc.record({ method: fc.constant("message" as const), input: fc.record({ text: fc.string() }) })
const responseArbitrary = (request: InferRequest): fc.Arbitrary<GeneratedModelResponse> =>
  request.trajectory.some(event => event.type === "ToolReturned")
    ? fc.constant({ kind: "complete", output: "done" } as const)
    : fc.integer({ min: 0, max: 100 }).map(value => ({
      kind: "calls" as const,
      calls: [{ callId: "generated", name: request.tools[0]!.name, arguments: { value } }],
    }))

const fakeServices = (model = responseArbitrary) => ({ generate }: ActorCheckContext) => {
  let value = 0
  return Layer.merge(
    Layer.succeed(Counter, { next: () => ++value }),
    testInferenceLayer({
      resolve: (selected = { provider: "test", model_id: "fake" }) => ({ model: selected, contextWindowTokens: 128_000 }),
      react: request => Effect.sync(() => generate(model, request)),
    }),
  )
}
const services = fakeServices()

const failed = async (run: Promise<unknown>): Promise<ActorCheckError> => {
  try { await run } catch (error) {
    if (error instanceof ActorCheckError) return error
    throw error
  }
  throw new Error("Expected counterexample")
}

test("generated model responses execute real tools with fresh services", async () => {
  const values = new Set<unknown>()
  const report = await checkActor(definition, {
    inputs, services, seed: 42, numRuns: 20,
    invariants: {
      isolated: ({ events }) => {
        for (const event of events) {
          if (event.type !== "ToolReturned") continue
          const result = event.result as { count: number; value: { value: number } }
          expect(result.count).toBe(1)
          values.add(result.value.value)
        }
      },
    },
  })
  expect(report.status).toBe("passed")
  expect(report.numRuns).toBe(20)
  expect(values.size).toBeGreaterThan(1)
})

test("shrinks generated responses and replays the invariant failure", async () => {
  const invariants = {
    small: ({ events }: { events: ReadonlyArray<{ readonly type: string; readonly arguments?: unknown }> }) => {
      const call = events.find(event => event.type === "ToolCalled")
      if (call !== undefined) expect((call.arguments as { value: number }).value).toBeLessThan(3)
    },
  }
  const error = await failed(checkActor(definition, { inputs, services, invariants, seed: 42, numRuns: 20 }))
  expect(error.counterexample.failure?.invariant).toBe("small")
  expect(error.numShrinks).toBeGreaterThan(0)
  const call = error.counterexample.example.choices[0] as GeneratedModelResponse | undefined
  expect(call?.kind).toBe("calls")
  if (call?.kind === "calls") expect(call.calls[0].arguments).toEqual({ value: 3 })
  const replay = await replayActor(definition, error.counterexample.example, { services, invariants })
  expect(replay.status).toBe("failed")
  expect(replay.failure?.invariant).toBe("small")
})

test("checks intermediate prefixes even when a later event would satisfy the rule", async () => {
  const error = await failed(checkActor(definition, {
    inputs, services, seed: 1, numRuns: 1,
    invariants: { noUnansweredCall: ({ events }) => {
      expect(events.filter(event => event.type === "ToolCalled").length)
        .toBe(events.filter(event => event.type === "ToolReturned").length)
    } },
  }))
  expect(error.counterexample.failure?.invariant).toBe("noUnansweredCall")
})

test("reports event-batch bounds without claiming a completed execution", async () => {
  const report = await checkActor(definition, {
    inputs, services, maxSteps: 1, numRuns: 2,
    invariants: { valid: () => {} },
  })
  expect(report).toMatchObject({ status: "bounded", boundedRuns: 2, policy: { maxSteps: 1 } })
})

test("generator errors fail the check even if inference catches the error", async () => {
  const error = await failed(checkActor(definition, {
    inputs, numRuns: 1,
    services: fakeServices(() => { throw new Error("broken generator") }),
    invariants: { valid: () => {} },
  }))
  expect(error.counterexample.failure?.kind).toBe("execution")
  expect(String(error.counterexample.failure?.cause)).toContain("broken generator")
})

test("rejects empty rules and invalid bounds", async () => {
  await expect(checkActor(definition, { inputs, services, invariants: {} })).rejects.toThrow("invariant")
  await expect(checkActor(definition, { inputs, services, invariants: { valid: () => {} }, maxSteps: 0 })).rejects.toThrow("maxSteps")
})

test("replay refuses missing and unused responses", async () => {
  const input = { method: "message", input: { text: "hi" } } as const
  const reply: GeneratedModelResponse = { kind: "complete", output: "done" }
  const options = { services, invariants: { valid: () => {} } }
  expect((await replayActor(definition, { input, choices: [] }, options)).status).toBe("failed")
  const result = await replayActor(definition, { input, choices: [reply, reply] }, options)
  expect(result.status).toBe("failed")
  expect(String(result.failure?.cause)).toContain("unused")
})

test("boolean invariants fail and the counterexample ends at the violating prefix", async () => {
  const error = await failed(checkActor(definition, {
    inputs, services, numRuns: 1, seed: 42,
    invariants: { noCalls: ({ events }) => !events.some(event => event.type === "ToolCalled") },
  }))
  expect(error.counterexample.events.at(-1)?.type).toBe("ToolCalled")
  expect(error.counterexample.example.policy?.maxSteps).toBe(100)
})

test("timeout fails a hanging execution and interrupts its effect", async () => {
  let interrupted = false
  const hanging = actor({
    name: "hanging",
    methods: { message: agentMessageMethod },
    components: [infer([outputValidateOnce, tool({
      spec: { name: "wait", description: "Wait", inputSchema: { type: "object" } },
      run: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true }))),
    })])],
  })
  const error = await failed(checkActor(hanging, {
    inputs: fc.constant({ method: "message", input: { text: "go" } }),
    services: fakeServices(() => fc.constant({ kind: "calls", calls: [{ callId: "wait", name: "wait", arguments: {} }] })),
    invariants: { valid: () => {} }, numRuns: 1, timeoutMs: 50,
  }))
  expect(error.counterexample.failure?.kind).toBe("execution")
  expect(interrupted).toBe(true)
})

test("a continuing model loop stops at the configured bound", async () => {
  const report = await checkActor(definition, {
    inputs, numRuns: 1, maxSteps: 12,
    services: fakeServices(request => fc.constant({ kind: "calls", calls: [{ callId: `call-${request.trajectory.length}`, name: "count", arguments: { value: 0 } }] })),
    invariants: { valid: () => {} },
  })
  expect(report.status).toBe("bounded")
})
