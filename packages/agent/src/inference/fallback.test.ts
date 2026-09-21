import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AiError } from "effect/unstable/ai"
import { KeyValueStore } from "effect/unstable/persistence"
import fc from "fast-check"
import { actor } from "@clavia/tardigrade-core/actor"
import { createHost } from "@clavia/tardigrade-host/host"
import { testInferenceLayer, type TestInference } from "../testing/inference"
import { agentMethods, infer, outputValidateOnce, tool } from "../index"
import { applyModelPolicy, modelPolicyOverrideOf } from "./access"
import { canFallback, type RequestPolicy } from "./retry"
import { usageIn } from "./usage"

const primary = { provider: "primary", model_id: "model" }
const secondary = { provider: "secondary", model_id: "model" }
const third = { provider: "third", model_id: "model" }
const models = { default: primary, fallback: [secondary, third] }
const policy: RequestPolicy = { maxOutputTokens: 100, timeout: { firstChunkMs: 90_000, idleMs: 90_000 }, retry: { backoffMs: [0, 0], maxRetryAfterMs: 1000, retryAfterJitterMs: 0 } }
const denied = AiError.make({ module: "Provider", method: "streamText", reason: AiError.InvalidRequestError.make({ description: "Region unavailable" }) })
const usage = { inputTokens: { total: 10 }, outputTokens: { total: 2 } }
const makeHost = (binding: TestInference, configured = models) => {
  const definition = actor({ name: "fallback", methods: agentMethods, components: [infer([outputValidateOnce, tool({ spec: { name: "read", description: "Read", inputSchema: { type: "object" } }, run: () => Effect.succeed("contents") })], { models: configured })] })
  return createHost({ actorName: "fallback", actorFor: () => definition, layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, testInferenceLayer({ policy: () => Effect.succeed(policy), ...binding })) })
}

test("fallback attempts are bounded, separately accounted, and recover at every response boundary", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 3 }), fc.boolean(), async (attempts, transient) => {
    const visited: string[] = []
    const host = makeHost({ policy: () => Effect.succeed({ ...policy, retry: { ...policy.retry, backoffMs: Array(attempts - 1).fill(0) } }), react: (request) => Effect.sync(() => {
      visited.push(request.model!.provider)
      return { kind: "fail", error: denied, retryable: transient, usage }
    }) }, { ...models, fallback: [primary, secondary, secondary, third, primary] })
    await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
    await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m", text: "hello", at: 1 })
    await host.drive()
    const perModel = transient ? attempts : 1
    expect(visited).toEqual([primary, secondary, third].flatMap(model => Array(perModel).fill(model.provider)))
    const log = JSON.parse(JSON.stringify(host.read("root"))) as ReturnType<typeof host.read>
    expect(log.filter(e => e.type === "TurnFailed")).toHaveLength(1)
    expect(log.filter(e => e.type === "ToolCalled")).toHaveLength(0)
    expect(log.filter(e => e.type === "ModelCalled")).toHaveLength(visited.length)
    expect(usageIn(log, "m")).toMatchObject({ promptTokens: 10 * visited.length, completionTokens: 2 * visited.length })
    const responses = log.filter(e => e.type === "ModelReturned")
    expect(new Set(responses.map(e => e.callId)).size).toBe(visited.length)
    for (const response of responses) {
      if (response.retry === undefined) continue
      const index = log.indexOf(response)
      const next = log.slice(index + 1).find(e => e.type === "ModelCalled")!
      const resumed = makeHost({ react: (request, key) => Effect.sync(() => {
        expect(next.model).toEqual(request.model)
        expect(next.callId).toBe(key)
        return { kind: "complete", output: "done" }
      }) })
      resumed.seed("root", log.slice(0, index + 1))
      await resumed.wake("root")
      await resumed.drive()
      expect(resumed.read("root").filter(e => e.type === "TurnCompleted")).toHaveLength(1)
    }
  }), { numRuns: 6, examples: [[3, true], [1, false]] })
})

test("a fallback remains selected through tools and crashes, and repeated candidates cannot loop", async () => {
  let calls = 0
  const host = makeHost({ react: request => Effect.sync(() => {
    calls++
    if (calls === 1) return { kind: "fail", error: denied }
    expect(request.model).toEqual(secondary)
    return calls === 2 ? { kind: "calls", calls: [{ callId: "read-1", name: "read", arguments: {} }] } : { kind: "complete", output: "done" }
  }) }, { ...models, fallback: [primary, secondary, secondary] })
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m", text: "hello", at: 1 })
  await host.drive()
  expect(calls).toBe(3)
  const log = host.read("root")
  expect(log.filter(e => e.type === "ToolReturned")).toHaveLength(1)
  const lastMark = log.findLastIndex(e => e.type === "ModelCalled")
  const recovered = makeHost({ react: (request, key) => Effect.sync(() => {
    expect(request.model).toEqual(secondary)
    expect(log[lastMark]!.callId).toBe(key)
    return { kind: "complete", output: "recovered" }
  }) })
  recovered.seed("root", log.slice(0, lastMark + 1))
  await recovered.wake("root")
  await recovered.drive()
  expect(recovered.read("root").filter(e => e.type === "TurnCompleted")).toHaveLength(1)
})

test("fallback authority is validated before any request and explicit empty lists disable inheritance", async () => {
  expect(() => modelPolicyOverrideOf({ ...models, allow: [{ provider: primary.provider, model_ids: "*" }] })).toThrow("fallback")
  expect(applyModelPolicy({ ...models, allow: "*" }, { fallback: [] }).fallback).toEqual([])
  const host = makeHost({ resolve: model => ({ model: model!, models: { allow: [{ provider: primary.provider, model_ids: "*" }] } }), react: () => Effect.die("must not request") })
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m", text: "hello", at: 1 })
  await host.drive()
  expect(host.read("root").filter(e => e.type === "ModelCalled")).toHaveLength(0)
  expect(host.read("root").filter(e => e.type === "TurnFailed")).toHaveLength(1)
})

test("local validation, refusal, truncation, and unknown failures do not trigger fallback", () => {
  for (const error of [new Error("defect"), AiError.make({ module: "Provider", method: "streamText", reason: AiError.InvalidUserInputError.make({ description: "Invalid local tool configuration" }) })]) {
    expect(canFallback({ kind: "fail", error })).toBe(false)
  }
  for (const cause of ["output_unsupported", "output_limit", "refused", "model_selection"] as const) {
    expect(canFallback({ kind: "fail", error: denied, failure: { cause, attempts: 1 } })).toBe(false)
  }
  expect(canFallback({ kind: "fail", error: denied })).toBe(true)
})


test("cancelled turns never execute a pending fallback", async () => {
  const host = makeHost({ react: () => Effect.die("cancelled request") })
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m", text: "hello", at: 1 })
  host.seed("root", [
    { type: "MessageReceived", id: "m", text: "hello", at: 1 },
    { type: "ModelCalled", callId: "m/infer/0", ordinal: 0, model: primary, turn: "m", at: 2 },
    { type: "ModelReturned", callId: "m/infer/0", ordinal: 0, outcome: "failed", usage: {}, retry: { dueAt: 3, index: 0, model: secondary }, turn: "m", at: 3 },
    { type: "TurnCancelled", turn: "m", at: 4 }
  ])
  await host.wake("root")
  await host.drive()
  expect(host.read("root").filter(e => e.type === "ModelCalled")).toHaveLength(1)
})
