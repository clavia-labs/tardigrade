import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { createHost } from "@clavia/tardigrade-host/host"
import { testInferenceLayer, type TestInference } from "../fixtures/model"
import { agentMethods, budget, infer, outputValidateOnce } from "../src/index"
import { usageIn } from "../src/model/usage"
import type { RequestPolicy } from "../src/component/infer/retry"

const limit = 0.05
const definition = actor({
  name: "budget-infer",
  methods: agentMethods,
  components: [budget(infer([outputValidateOnce], {
    models: { default: { provider: "test", model_id: "fixture" }, allow: "*" }
  }), {
    limit,
    accounting: "completed",
    usage: ({ estimatedCostUsd }) => estimatedCostUsd ?? limit,
    onExhausted: (reason, respond) => respond({ error: reason })
  })]
})
const policy: RequestPolicy = {
  maxOutputTokens: 2000,
  timeout: { firstChunkMs: 90_000, idleMs: 90_000 },
  retry: { backoffMs: [0, 0, 0, 0, 0], maxRetryAfterMs: 1000, retryAfterJitterMs: 0 }
}
const makeHost = (react: TestInference["react"]) => createHost({
  actorName: definition.name,
  actorFor: () => definition,
  layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, testInferenceLayer({
    policy: () => Effect.succeed(policy),
    pricing: () => Effect.succeed({ promptUsdPerToken: 0.0000025, completionUsdPerToken: 0.00001 }),
    react
  }))
})

test("completed catalog cost blocks the fifth attempt and survives replay", async () => {
  let calls = 0
  const react: TestInference["react"] = () => Effect.sync(() => {
    calls++
    return { kind: "fail", retryable: true, error: { message: "busy" }, usage: { inputTokens: { total: 1234 }, outputTokens: { total: 1239 } } }
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
        : { kind: "fail" as const, retryable: true, error: { message: "busy" } }
    }))
    await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
    await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "go", at: 1 })
    await host.drive()
    expect(calls).toBe(1)
    expect(host.read("root").filter(event => event.type === (complete ? "TurnCompleted" : "TurnFailed"))).toHaveLength(1)
  }
})
