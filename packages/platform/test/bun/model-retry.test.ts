import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Stream } from "effect"
import { AiError } from "effect/ai"
import { Agent } from "@clavia/tardigrade-agent"
import { Actor, AttemptTimedOut, RuntimeError, StreamTimedOut } from "@clavia/tardigrade-core"
import { StreamBoundExceeded, StreamIncomplete } from "@clavia/tardigrade-model/stream/request"
import { modelRetry } from "../../../agent/src/services/model-retry"
import { host } from "../../src/bun"
import { contentModelServices } from "../fixtures/agent"

const failure = (reason: AiError.AiError["reason"]) => AiError.make({ module: "Fixture", method: "streamText", reason })

test("model retry translates provider classification and wait hints within its budget", async () => {
  const policy = { backoffMs: [0], retryAfterJitterMs: 0, maxRetryAfterMs: 100 }
  const retry = modelRetry(policy)
  const rateLimit = failure(AiError.RateLimitError.make({ retryAfter: Duration.millis(25) }))
  expect(await Effect.runPromise(retry.decide(new RuntimeError("wrapped provider failure", { cause: rateLimit }), 0))).toMatchObject({ delayMs: 25, reason: { policy, retryAfterMs: 25 } })
  for (const [error, attempt] of [
    [failure(AiError.AuthenticationError.make({ kind: "InvalidKey", description: "invalid credentials" })), 0],
    [new RuntimeError("wrapped provider failure", { cause: failure(AiError.AuthenticationError.make({ kind: "InvalidKey", description: "invalid credentials" })) }), 0],
    [failure(AiError.RateLimitError.make({ retryAfter: Duration.millis(101) })), 0],
    [rateLimit, 1],
  ] as const) expect(await Effect.runPromise(retry.decide(error, attempt))).toBeUndefined()
})

test("model retry schedules native stream gaps and early ends within its budget", async () => {
  const policy = { backoffMs: [0], retryAfterJitterMs: 0, maxRetryAfterMs: 100 }
  const retry = modelRetry(policy)
  for (const [error, evidence] of [
    [new StreamTimedOut({ bound: "firstChunkMs", timeoutMs: 10 }), { _tag: "StreamTimedOut", bound: "firstChunkMs", timeoutMs: 10 }],
    [new StreamTimedOut({ bound: "idleMs", timeoutMs: 10 }), { _tag: "StreamTimedOut", bound: "idleMs", timeoutMs: 10 }],
    [new StreamIncomplete(), { _tag: "StreamIncomplete" }],
    [new StreamBoundExceeded({ bound: "idleMs" }), { _tag: "StreamBoundExceeded", bound: "idleMs" }],
    [new RuntimeError("wrapped stream failure", { cause: new StreamIncomplete() }), { _tag: "StreamIncomplete" }],
  ] as const) expect(await Effect.runPromise(retry.decide(error, 0))).toEqual({ delayMs: 0, reason: { error: evidence, policy } })
  for (const [error, attempt] of [
    [new StreamIncomplete(), 1],
    [new StreamBoundExceeded({ bound: "attemptMs" }), 0],
    [AttemptTimedOut.make({ timeoutMs: 10 }), 0],
  ] as const) expect(await Effect.runPromise(retry.decide(error, attempt))).toBeUndefined()
})

test("a native agent turn survives a stalled stream and an early end in one model operation", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-stream-retry-"))
  let calls = 0
  const model = contentModelServices(() => {}, {
    request: { retry: { backoffMs: [0, 0], retryAfterJitterMs: 0 }, timeout: { firstChunkMs: 200, idleMs: 200 } },
    stream: () => ++calls === 1 ? Stream.never : calls === 2 ? Stream.empty : undefined,
  })
  const assistant = Actor.make("stream-retry", Effect.gen(function* () {
    const context = yield* Agent.compact(Agent.messages)
    return yield* Agent.make({ system: "Reply.", tools: yield* Agent.tools([]), context })
  }))
  const runtime = await Effect.runPromise(host(assistant, { storage, layer: model }))
  try {
    const thread = await Effect.runPromise(runtime.allocateRootThread({ instance: "main", name: "thread" }))
    await Effect.runPromise(thread.invoke("message", { text: "Hello" }, { id: "hello" }))
    expect(await Effect.runPromise(thread.result("message", "hello"))).toEqual({ status: "completed", output: { text: "ok" } })
    expect(calls).toBe(3)
    const records = await Effect.runPromise(thread.records())
    const retries = records.flatMap(record => record.event.type === "RetryScheduled" ? [record.event] : [])
    expect(retries.map(retry => ({ attempt: retry.attempt, error: (retry.reason as { readonly error: unknown }).error }))).toEqual([
      { attempt: 1, error: { _tag: "StreamTimedOut", bound: "firstChunkMs", timeoutMs: 200 } },
      { attempt: 2, error: { _tag: "StreamIncomplete" } },
    ])
    expect(new Set(retries.map(retry => retry.ref.seq)).size).toBe(1)
    expect(records.filter(record => record.event.type === "ModelReturned" && record.event.purpose === "inference")).toHaveLength(1)
  } finally {
    await Effect.runPromise(runtime.close)
    await rm(storage, { recursive: true, force: true })
  }
})
