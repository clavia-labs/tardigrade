import { expect, test } from "bun:test"
import { Context, Duration, Effect, Layer, Schema, Stream } from "effect"
import { AiError, LanguageModel, Response } from "effect/unstable/ai"
import { atom, defineActor, ExecutionResult, type CoreEvent } from "@clavia/tardigrade-core"
import { infer } from "@clavia/tardigrade-agent/atoms/infer"
import { ModelInfo } from "@clavia/tardigrade-agent/actor/context"
import { Event, requestTurn } from "@clavia/tardigrade-agent/contracts/events"
import { modelActs, modelServices, ModelLock } from "@clavia/tardigrade-agent/services/model"
import { BindingSettings } from "@clavia/tardigrade-model/settings"
import { requestPolicyOf } from "@clavia/tardigrade-model/stream/request"
import { bunPromises } from "../../src/bun/promises"
import { createTestStore } from "../properties/runtime/store"

const model = { provider: "fixture", model_id: "scripted" }
const actor = defineActor("inference-retry", Effect.gen(function* () {
  const root = yield* infer(atom(() => ({ system: "Answer with one word.",
    tools: { view: { specs: [] }, events: {}, acts: {} },
    context: { view: { position: "ready" as const, messages: [{ role: "user" as const, text: "probe" }] }, events: {}, acts: {} },
  })))
  return { atom: root, schema: Event }
}))
const rateLimit = (ms: number) => AiError.make({ module: "fixture", method: "streamText", reason: AiError.RateLimitError.make({ retryAfter: Duration.millis(ms) }) })
const waitUntil = (predicate: () => boolean) => Effect.gen(function* () { while (!predicate()) yield* Effect.sleep(1) }).pipe(Effect.timeout(2_000))

function fixture(options: { failures: number; error?: AiError.AiError; backoffMs?: number[] }) {
  const calls: number[] = []
  const policy = requestPolicyOf({ maxOutputTokens: 1024, retry: { backoffMs: options.backoffMs ?? [20, 20], maxRetryAfterMs: 20, retryAfterJitterMs: 0 } })
  const languageModel = Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
    generateText: () => Effect.die("Uses streaming"),
    streamText: () => Stream.unwrap(Effect.sync(() => {
      calls.push(calls.length)
      if (calls.length <= options.failures) return Stream.fail(options.error ?? rateLimit(7))
      return Stream.fromIterable([
        Response.makePart("text-start", { id: "t" }),
        Response.makePart("text-delta", { id: "t", delta: "recovered" }),
        Response.makePart("text-end", { id: "t" }),
        Response.makePart("finish", { reason: "stop", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }),
      ])
    })),
  }))
  const lock = Layer.succeed(ModelLock, { resolve: () => ({ model, contextWindowTokens: 128_000 }) } as typeof ModelLock.Service)
  const settings = Layer.succeed(BindingSettings, { provider: model.provider, protocol: "effect", model: model.model_id, endpoint: "https://invalid.test", policy })
  const services = modelActs.pipe(Layer.provideMerge(modelServices().pipe(Layer.provideMerge(Layer.mergeAll(languageModel, lock, settings)))))
  const open = (events?: readonly (Event | CoreEvent)[]) => createTestStore({ actor, ...(events ? { events } : {}), checkpoint: { mode: "manual" }, actorContext: Context.pick(ModelInfo), services: runtime => Layer.mergeAll(
    Layer.succeed(ModelInfo, { model, contextWindowTokens: 128_000 }), services,
    bunPromises(runtime, { deliver: settlement => runtime.send([settlement]) }),
  ) })
  return { calls, open }
}

for (const [name, failures, error, backoffMs, expectedCalls, outcome] of [
  ["rate limit then success", 1, rateLimit(7), [20, 20], 2, "completed"],
  ["exhaustion", 9, rateLimit(7), [0, 0], 3, "failed"],
  ["long retry-after uses backoff", 1, rateLimit(1000), [5], 2, "completed"],
  ["typed non-retryable failure", 1, AiError.make({ module: "fixture", method: "streamText", reason: AiError.InvalidRequestError.make({ description: "Refused" }) }), [0, 0], 1, "failed"],
] as const) test(`native inference retry: ${name}`, async () => {
  const f = fixture({ failures, error, backoffMs: [...backoffMs] })
  const store = await Effect.runPromise(f.open())
  try {
    await Effect.runPromise(store.send([requestTurn({ text: "probe", turnId: "turn" })]))
    await Effect.runPromise(waitUntil(() => store.snapshot().events.some(event => event.type === "TurnSettled")))
    expect(f.calls).toHaveLength(expectedCalls)
    const events = store.snapshot().events
    expect(events.find(event => event.type === "TurnSettled")).toMatchObject({ outcome })
    expect(events.filter(event => event.type === "ModelFailed")).toHaveLength(outcome === "failed" ? 1 : 0)
    expect(events.filter(event => event.type === "ModelCalled")).toHaveLength(expectedCalls)
    expect(events.filter(event => event.type === "ModelRetryScheduled")).toHaveLength(expectedCalls - 1)
    if (outcome === "completed") expect(events.find(event => event.type === "ModelReturned")).toMatchObject({ text: "recovered" })
    const retry = events.find(event => event.type === "ModelRetryScheduled")
    if (retry?.type === "ModelRetryScheduled") {
      expect(retry.delayMs).toBe(name === "long retry-after uses backoff" ? 5 : 7)
    }
  } finally { await Effect.runPromise(store.close) }
})

test("native inference replay retains the backoff deadline and performs one next attempt", async () => {
  const f = fixture({ failures: 1, error: rateLimit(1000), backoffMs: [150] })
  let store = await Effect.runPromise(f.open())
  try {
    await Effect.runPromise(store.send([requestTurn({ text: "probe", turnId: "turn" })]))
    await Effect.runPromise(waitUntil(() => store.snapshot().events.some(event => event.type === "EffectSettled" && event.outcome.status === "fulfilled" && Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value).type === "promise" && event.ref.tag.startsWith("retry:"))))
    const events = JSON.parse(JSON.stringify(store.snapshot().events)) as (Event | CoreEvent)[]
    const retry = events.find(event => event.type === "ModelRetryScheduled")!
    expect(retry.type).toBe("ModelRetryScheduled")
    expect(f.calls).toHaveLength(1)
    await Effect.runPromise(store.close)
    store = await Effect.runPromise(f.open(events))
    await Effect.runPromise(waitUntil(() => store.snapshot().events.some(event => event.type === "TurnSettled")))
    expect(f.calls).toHaveLength(2)
    expect(store.snapshot().events.filter(event => event.type === "ModelRetryScheduled")).toHaveLength(1)
    expect(store.snapshot().events.filter(event => event.type === "ModelRetryReady")).toHaveLength(1)
    const completed = store.snapshot().events
    await Effect.runPromise(store.close)
    store = await Effect.runPromise(f.open(completed))
    await Effect.runPromise(store.wait)
    expect(f.calls).toHaveLength(2)
  } finally { await Effect.runPromise(store.close) }
})
