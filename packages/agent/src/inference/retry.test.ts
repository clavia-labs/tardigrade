import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { testInferenceLayer, type TestInference } from "@clavia/tardigrade-agent/testing/inference"
import { expect, test } from "bun:test"
import { Clock, Effect, Layer } from "effect"
import fc from "fast-check"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import { createHost } from "@clavia/tardigrade-host/host"
import { agentMethods, infer, outputValidateOnce } from "../index"

import { retryDelayOf, type RequestPolicy } from "./retry"
import { usageIn } from "./usage"

const policy: RequestPolicy = { maxOutputTokens: 100, timeout: { firstChunkMs: 90_000, idleMs: 90_000 }, retry: { backoffMs: [0], maxRetryAfterMs: 1000, retryAfterJitterMs: 0 } }
const definition = actor({ name: "retry-test", methods: agentMethods, components: [infer([outputValidateOnce], { models: { default: { provider: "test", model_id: "fixture" }, allow: "*" } })] })
const makeHost = (binding: TestInference) => createHost({ actorName: "retry-test", actorFor: () => definition, layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, testInferenceLayer( binding)) })

test.each([false, true])("physical attempts commit separately and recovery uses current allowance (exhausted: %s)", async (exhausted) => {
  let count = 0
  const keys: Array<string | undefined> = []
  const host = makeHost({ policy: () => Effect.succeed(policy), react: (request, key) => Effect.sync(() => {
    const log = host.read("root")
    expect(log.filter((e) => e.type === "ModelCalled")).toHaveLength(count + 1)
    expect(log.filter((e) => e.type === "ModelReturned")).toHaveLength(count)
    expect(request).not.toHaveProperty("policy")
    expect(log.filter((e) => e.type === "ModelCalled").every((e) => e.policy === undefined)).toBe(true)
    keys.push(key)
    count++
    return count === 1 || exhausted
      ? { kind: "fail" as const, retryable: true, error: { message: "busy", isRetryable: true }, usage: { inputTokens: { total: 100 }, outputTokens: { total: 20 } } }
      : { kind: "complete" as const, output: "done", usage: { inputTokens: { total: 100 }, outputTokens: { total: 30 } } }
  }) })
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "Hello", at: 1 })
  await host.drive()
  const log = JSON.parse(JSON.stringify(host.read("root"))) as ReturnType<typeof host.read>
  expect(keys).toEqual(["m1/infer/0", "m1/infer/1"])
  expect(log.filter((e) => e.type === "ModelReturned").map((e) => e.outcome)).toEqual(["failed", exhausted ? "failed" : "returned"])
  expect(usageIn(log, "m1")).toMatchObject({ promptTokens: 200, completionTokens: exhausted ? 40 : 50 })
  const first = log.findIndex((e) => e.type === "ModelReturned")
  let resumedCalls = 0
  const resumed = makeHost({ policy: () => Effect.succeed({ ...policy, retry: { ...policy.retry, backoffMs: [0, 0, 0, 0] } }), react: (request, key) => Effect.sync(() => {
    resumedCalls++
    expect(key).toBe(`m1/infer/${resumedCalls}`)
    expect(request).not.toHaveProperty("policy")
    return { kind: "fail" as const, retryable: true, error: { message: "busy", isRetryable: true } }
  }) })
  resumed.seed("root", log.slice(0, first + 1))
  await resumed.wake("root")
  await resumed.drive()
  expect(resumedCalls).toBe(4)
  expect(resumed.read("root").filter((e) => e.type === "TurnFailed")).toHaveLength(1)
  expect(resumed.read("root").filter((e) => e.type === "ModelReturned")).toHaveLength(5)
})

test("physical attempts retain resolved request evidence across replay", async () => {
  const policies: ReadonlyArray<RequestPolicy> = [
    { ...policy, maxOutputTokens: 111, retry: { ...policy.retry, backoffMs: [0] } },
    { ...policy, maxOutputTokens: 222, retry: { ...policy.retry, backoffMs: [7, 9] } }
  ]
  const prices = [
    { promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 },
    { promptUsdPerToken: 0.002, completionUsdPerToken: 0.004 }
  ] as const
  const maximumUsd = (index: number) =>
    128_000 * prices[index]!.promptUsdPerToken + policies[index]!.maxOutputTokens * prices[index]!.completionUsdPerToken
  let attempts = 0
  const atDispatch: Array<{ readonly requestPolicy: unknown; readonly requestBounds: unknown; readonly returned: number }> = []
  const host = makeHost({
    policy: () => Effect.succeed(policies[Math.min(attempts, policies.length - 1)]!),
    pricing: () => Effect.succeed(prices[Math.min(attempts, prices.length - 1)]!),
    react: () => Effect.sync(() => {
      const log = host.read("root")
      const mark = log.findLast((event) => event.type === "ModelCalled") as Record<string, unknown>
      atDispatch.push({
        requestPolicy: mark.requestPolicy,
        requestBounds: mark.requestBounds,
        returned: log.filter((event) => event.type === "ModelReturned").length
      })
      return ++attempts === 1
        ? { kind: "fail" as const, retryable: true, error: "capacity", usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } }
        : { kind: "complete" as const, output: "done", usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } }
    })
  })
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "Hello", at: 1 })
  await host.drive()

  const recorded = JSON.parse(JSON.stringify(host.read("root"))) as ReadonlyArray<Record<string, unknown>>
  const evidence = recorded.filter((event) => event.type === "ModelCalled").map((event) => ({
    requestPolicy: event.requestPolicy,
    requestBounds: event.requestBounds
  }))
  const changed = makeHost({
    policy: () => Effect.succeed({ ...policy, maxOutputTokens: 999, retry: { ...policy.retry, backoffMs: [] } }),
    pricing: () => Effect.succeed({ promptUsdPerToken: 1, completionUsdPerToken: 1 }),
    react: () => Effect.die("a completed replay must not dispatch")
  })
  changed.seed("root", recorded as ReturnType<typeof host.read>)
  await changed.wake("root")
  await changed.drive()
  const replayedEvidence = JSON.parse(JSON.stringify(changed.read("root"))).filter((event: Record<string, unknown>) => event.type === "ModelCalled").map((event: Record<string, unknown>) => ({
    requestPolicy: event.requestPolicy,
    requestBounds: event.requestBounds
  }))
  const measuredCostUsd = usageIn(recorded as ReturnType<typeof host.read>, "m1").costUsd
  expect(atDispatch.map(({ returned }) => returned)).toEqual([0, 1])
  expect(atDispatch.map(({ returned: _returned, ...item }) => item)).toEqual(evidence)
  expect(replayedEvidence).toEqual(evidence)
  for (const [index, item] of evidence.entries()) {
    expect(item).toMatchObject({ requestPolicy: policies[index], requestBounds: { maximumUsd: expect.any(Number) } })
    expect((item.requestBounds as { readonly maximumUsd: number }).maximumUsd).toBeCloseTo(maximumUsd(index), 9)
  }
  expect(measuredCostUsd).toBeCloseTo(10 * prices[1].promptUsdPerToken + prices[1].completionUsdPerToken, 9)
})

test("an unpriced failure retains its conservative bound beside unknown usage", async () => {
  const requestPolicy = { ...policy, maxOutputTokens: 45_268, retry: { ...policy.retry, backoffMs: [] } }
  const pricing = { promptUsdPerToken: 0.0000025, completionUsdPerToken: 0.00001 }
  const host = makeHost({
    policy: () => Effect.succeed(requestPolicy),
    pricing: () => Effect.succeed(pricing),
    react: () => Effect.succeed({ kind: "fail", error: "connection reset", usage: { inputTokens: {}, outputTokens: {} } })
  })
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "Hello", at: 1 })
  await host.drive()

  const replayed = JSON.parse(JSON.stringify(host.read("root"))) as ReturnType<typeof host.read>
  const mark = replayed.find((event) => event.type === "ModelCalled") as Record<string, unknown>
  expect(mark).toMatchObject({ requestPolicy, requestBounds: { maximumUsd: expect.any(Number) } })
  expect((mark.requestBounds as { readonly maximumUsd: number }).maximumUsd).toBeCloseTo(
    128_000 * pricing.promptUsdPerToken + requestPolicy.maxOutputTokens * pricing.completionUsdPerToken,
    9
  )
  expect(usageIn(replayed, "m1").costUsd).toBeUndefined()
})

test("retry delays obey the explicit provider wait limit independently of backoff", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 }), fc.double({ min: 0, max: 1, noNaN: true }), (base, minimum, random) => {
    const configured = { ...policy, retry: { backoffMs: [base], maxRetryAfterMs: 500, retryAfterJitterMs: 10 } }
    expect(retryDelayOf(configured, 1, undefined, random)).toBeUndefined()
    const delay = retryDelayOf(configured, 0, minimum, random)
    if (minimum > 500) expect(delay).toBeUndefined()
    else { expect(delay).toBeGreaterThanOrEqual(minimum); expect(delay).toBeLessThanOrEqual(minimum + 10) }
  }))
})

for (const overdue of [false, true]) {
  test(`recovery honors the stored due time (overdue: ${overdue})`, async () => {
    const dueAt = Date.now() + (overdue ? -1000 : 25)
    let dispatchedAt = 0
    const host = makeHost({ policy: () => Effect.succeed({ ...policy, maxOutputTokens: 999 }), react: (request, key) => Effect.gen(function* () {
      dispatchedAt = yield* Clock.currentTimeMillis
      expect(dispatchedAt).toBeGreaterThanOrEqual(dueAt)
      expect(request).not.toHaveProperty("policy")
      expect(key).toBe("m1/infer/1")
      return { kind: "complete" as const, output: "done" }
    }) })
    await host.allocate({ kind: "root", coordinate: { actor: "retry-test", instance: "main", thread: "root" } })
    host.seed("root", [
      { type: "MessageReceived", id: "m1", text: "Hello", at: 1 },
      { type: "ModelCalled", callId: "m1/infer/0", ordinal: 0, turn: "m1", policy, retryIndex: 0, model: { provider: "test", model_id: "fixture" }, at: 2 },
      { type: "ModelReturned", callId: "m1/infer/0", ordinal: 0, turn: "m1", outcome: "failed", usage: { inputTokens: {}, outputTokens: {} }, retry: { dueAt, index: 1, policy }, at: 3 }
    ])
    await host.wake("root")
    await host.drive()
    expect(dispatchedAt).toBeGreaterThan(0)
    expect(host.read("root").filter((event) => event.type === "ModelCalled")).toHaveLength(2)
  })
}

test("a crashed physical attempt reuses its idempotency key without restoring saved policy", async () => {
  const host = makeHost({ policy: () => Effect.succeed({ ...policy, maxOutputTokens: 999 }), react: (request, key) => Effect.sync(() => {
    expect(key).toBe("m1/infer/0")
    expect(request).not.toHaveProperty("policy")
    return { kind: "complete" as const, output: "done" }
  }) })
  await host.allocate({ kind: "root", coordinate: { actor: "retry-test", instance: "main", thread: "root" } })
  host.seed("root", [
    { type: "MessageReceived", id: "m1", text: "Hello", at: 1 },
    { type: "ModelCalled", callId: "m1/infer/0", ordinal: 0, turn: "m1", policy, retryIndex: 0, model: { provider: "test", model_id: "fixture" }, at: 2 }
  ])
  await host.wake("root")
  await host.drive()
  expect(host.read("root").filter((event) => event.type === "ModelCalled").map((event) => event.callId)).toEqual(["m1/infer/0", "m1/infer/0"])
})

test("pricing is derived from the accounting snapshot without changing response usage", () => {
  const usage = { inputTokens: { total: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20 } }
  const log = [
    { type: "ModelCalled", callId: "a", ordinal: 0, turn: "m1", pricing: { promptUsdPerToken: 1, completionUsdPerToken: 2 }, at: 1 },
    { type: "ModelReturned", callId: "a", ordinal: 0, turn: "m1", outcome: "returned", usage, at: 2 }
  ]
  expect(usageIn(log, "m1")).toMatchObject({ estimatedCostUsd: 140 })
  expect(usage).not.toHaveProperty("costUsd")
})
