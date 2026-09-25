import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { createHost } from "@clavia/tardigrade-host/host"
import { testInferenceLayer, type TestInference } from "@clavia/tardigrade-agent/testing/model"
import { agentMethods, budget, infer, outputValidateOnce } from "../src/index"
import { usageIn } from "../src/model/usage"
import type { RequestPolicy } from "../src/component/infer/retry"

const limit = 0.05
const definition = (limit: number) => actor({
  name: "budget-infer",
  methods: agentMethods,
  components: [budget(infer([outputValidateOnce], {
    models: { default: { provider: "test", model_id: "fixture" }, allow: "*" }
  }), {
    limit,
    usage: ({ estimatedCostUsd }) => estimatedCostUsd ?? (limit + 1),
    onExhausted: (reason, respond) => respond({ error: reason })
  })]
})
const policy: RequestPolicy = {
  maxOutputTokens: 2000,
  timeout: { firstChunkMs: 90_000, idleMs: 90_000 },
  retry: { backoffMs: [0, 0, 0, 0, 0], maxRetryAfterMs: 1000, retryAfterJitterMs: 0 }
}
const makeHost = (react: TestInference["react"], allowance = limit) => createHost({
  actorName: "budget-infer",
  actorFor: () => definition(allowance),
  layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, testInferenceLayer({
    policy: () => Effect.succeed(policy),
    pricing: () => Effect.succeed({ promptUsdPerToken: 0.0000025, completionUsdPerToken: 0.00001 }),
    react
  }))
})

test("completed catalog cost blocks the fifth attempt and survives replay", async () => {
  let calls = 0
  const react: TestInference["react"] = (_request, key) => Effect.sync(() => {
    calls++
    return { kind: "calls", calls: [{ callId: `${key}/read`, name: "ghost", arguments: {} }], usage: { inputTokens: { total: 1234 }, outputTokens: { total: 1239 } } }
  })
  const host = makeHost(react)
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "go", at: 1 })
  await host.drive()
  const log = JSON.parse(JSON.stringify(host.read("root"))) as ReturnType<typeof host.read>
  expect(calls).toBe(4)
  expect(log.filter(event => event.type === "ModelCalled")).toHaveLength(4)
  expect(log.filter(event => event.type === "ModelReturned")).toHaveLength(4)
  expect(usageIn(log, "m1").estimatedCostUsd).toBeCloseTo(0.0619)
  const exhausted = log.filter(event => event.type === "BudgetExhausted")
  expect(exhausted).toHaveLength(1)
  expect(exhausted[0]!.used).toBeCloseTo(0.0619)
  expect(log.filter(event => event.type === "TurnFailed")).toMatchObject([{ cause: "refused", error: { message: "Budget exhausted." } }])

  const second = log.map((event, index) => ({ event, index })).filter(({ event }) => event.type === "ModelReturned")[1]!.index
  const resumed = makeHost(react)
  resumed.seed("root", log.slice(0, second + 1))
  calls = 0
  await resumed.wake("root")
  await resumed.drive()
  expect(calls).toBe(2)
  expect(resumed.read("root").filter(event => event.type === "ModelCalled")).toHaveLength(4)
  expect(resumed.read("root").filter(event => event.type === "TurnFailed")).toHaveLength(1)
})

test("unknown usage blocks further execution while a completed result still settles", async () => {
  for (const complete of [false, true]) {
    let calls = 0
    const host = makeHost(() => Effect.sync(() => {
      calls++
      return complete ? { kind: "complete" as const, output: "done" }
        : { kind: "calls" as const, calls: [{ callId: "read", name: "ghost", arguments: {} }] as const }
    }))
    await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
    await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "go", at: 1 })
    await host.drive()
    expect(calls).toBe(1)
    expect(host.read("root").filter(event => event.type === (complete ? "TurnCompleted" : "TurnFailed"))).toHaveLength(1)
  }
})


test("an attempt at exactly the limit runs, then blocks further work", async () => {
  let calls = 0
  const perAttempt = 1234 * 0.0000025 + 1239 * 0.00001
  const host = makeHost(() => Effect.sync(() => {
    calls++
    return { kind: "calls", calls: [{ callId: `read-${calls}`, name: "ghost", arguments: {} }], usage: { inputTokens: { total: 1234 }, outputTokens: { total: 1239 } } }
  }), perAttempt)
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "go", at: 1 })
  await host.drive()
  expect(calls).toBe(2)
  expect(host.read("root").filter(event => event.type === "ModelCalled")).toHaveLength(2)
  expect(host.read("root").filter(event => event.type === "TurnFailed")).toHaveLength(1)
})

test("turn and lifetime limits both govern inference across turns and restart", async () => {
  let calls = 0
  const create = () => createHost({
    actorName: "budget-infer",
    actorFor: () => actor({
      name: "budget-infer",
      methods: agentMethods,
      components: [budget(infer([outputValidateOnce], {
        models: { default: { provider: "test", model_id: "fixture" }, allow: "*" }
      }), {
        limits: [
          { limit: 0.03, usage: ({ cost }) => cost.turn.estimatedCostUsd ?? 1, rejectionMessage: "Turn limit reached." },
          { limit: 0.05, usage: ({ cost }) => cost.lifetime.estimatedCostUsd ?? 1, onExhausted: (_reason, respond) => respond({ error: "Lifetime limit reached." }) }
        ],
        onExhausted: (reason, respond) => respond({ error: reason })
      })]
    }),
    layersFor: () => testInferenceLayer({
      policy: () => Effect.succeed(policy),
      pricing: () => Effect.succeed({ promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 }),
      react: () => Effect.sync(() => {
        calls++
        return { kind: "calls", calls: [{ callId: `read-${calls}`, name: "ghost", arguments: {} }], usage: { inputTokens: { total: 20 }, outputTokens: { total: 0 } } }
      })
    })
  })
  const host = create()
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  for (const [index, expected] of [2, 3, 3].entries()) {
    await host.commitRoot(host.self("root"), { type: "MessageReceived", id: `m${index}`, text: "go", at: index + 1 })
    await host.drive()
    expect(calls).toBe(expected)
  }
  const log = host.read("root")
  expect(log.filter(event => event.type === "TurnFailed").map(event => event.error)).toEqual([
    { message: "Turn limit reached." }, { message: "Lifetime limit reached." }, { message: "Lifetime limit reached." }
  ])
  expect(log.filter(event => event.type === "BudgetGranted")).toHaveLength(0)
  expect(usageIn(log).estimatedCostUsd).toBeCloseTo(0.06)
  const resumed = create()
  resumed.seed("root", JSON.parse(JSON.stringify(log)))
  await resumed.allocate({ kind: "root", coordinate: parseThreadAddress(resumed.self("root")) })
  await resumed.commitRoot(resumed.self("root"), { type: "MessageReceived", id: "m3", text: "go", at: 4 })
  await resumed.drive()
  expect(calls).toBe(3)
  expect(resumed.read("root").filter(event => event.type === "TurnFailed")).toHaveLength(4)
})


test("excluded failures preserve catalog spend and permit budgeted retry", async () => {
  let calls = 0
  const host = makeHost(() => Effect.sync(() => {
    calls++
    return calls === 1
      ? { kind: "fail" as const, retryable: true, error: { message: "busy" } }
      : { kind: "complete" as const, output: "done", usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }
  }), limit)
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  host.seed("root", [
    { type: "MessageReceived", id: "previous", text: "go", at: 0 },
    { type: "ModelCalled", callId: "previous/infer/0", ordinal: 0, turn: "previous", pricing: { promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 }, at: 1 },
    { type: "ModelReturned", callId: "previous/infer/0", ordinal: 0, turn: "previous", outcome: "returned", usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }, at: 2 },
    { type: "TurnCompleted", turn: "previous", output: "done", at: 3 }
  ])
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "go", at: 4 })
  await host.drive()
  const log = host.read("root")
  expect(calls).toBe(2)
  expect(log.filter(event => event.type === "BudgetExhausted")).toHaveLength(0)
  expect(log.filter(event => event.type === "TurnCompleted" && event.turn === "m1")).toHaveLength(1)
  expect(usageIn(log).estimatedCostUsd).toBeCloseTo(0.020075)
  const first = log.findIndex(event => event.type === "ModelReturned" && event.outcome === "failed")
  expect(usageIn(log.slice(0, first + 1)).estimatedCostUsd).toBeCloseTo(0.02)
})
