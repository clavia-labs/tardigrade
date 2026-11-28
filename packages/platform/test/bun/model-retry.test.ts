import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Stream } from "effect"
import { AiError, Response } from "effect/ai"
import { Agent } from "@clavia/tardigrade-agent"
import { Actor, RuntimeError } from "@clavia/tardigrade-core"
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

test("a native agent turn survives first-chunk stall, idle stall, and early end in one model operation", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-stream-retry-"))
  let calls = 0
  const model = contentModelServices(() => {}, {
    request: { retry: { backoffMs: [0, 0, 0], retryAfterJitterMs: 0 }, timeout: { firstChunkMs: 150, idleMs: 150 } },
    stream: () => {
      const attempt = ++calls
      if (attempt === 1) return Stream.never
      if (attempt === 2) return Stream.concat(
        Stream.make(Response.makePart("text-start", { id: "partial" }), Response.makePart("text-delta", { id: "partial", delta: "partial" })),
        Stream.never,
      )
      if (attempt === 3) return Stream.empty
      return undefined
    },
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
    expect(calls).toBe(4)
    const records = await Effect.runPromise(thread.records())
    const retries = records.flatMap(record => record.event.type === "RetryScheduled" ? [record.event] : [])
    expect(retries.map(retry => ({ attempt: retry.attempt, error: (retry.reason as { readonly error: unknown }).error }))).toEqual([
      { attempt: 1, error: { _tag: "StreamTimedOut", bound: "firstChunkMs", timeoutMs: 150 } },
      { attempt: 2, error: { _tag: "StreamTimedOut", bound: "idleMs", timeoutMs: 150 } },
      { attempt: 3, error: { _tag: "StreamIncomplete" } },
    ])
    expect(new Set(retries.map(retry => retry.ref.seq)).size).toBe(1)
    expect(records.filter(record => record.event.type === "ModelReturned" && record.event.purpose === "inference")).toHaveLength(1)
  } finally {
    await Effect.runPromise(runtime.close)
    await rm(storage, { recursive: true, force: true })
  }
})

test("a native agent turn treats attempt timeout and exhausted stream retry budget as terminal", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-stream-terminal-"))
  let attemptTimeoutCalls = 0
  const timeoutModel = contentModelServices(() => {}, {
    request: { retry: { backoffMs: [0], retryAfterJitterMs: 0 }, timeout: { attemptMs: 120, firstChunkMs: 500, idleMs: 500 } },
    stream: () => { attemptTimeoutCalls++; return Stream.never },
  })
  const makeAssistant = (name: string) => Actor.make(name, Effect.gen(function* () {
    const context = yield* Agent.compact(Agent.messages)
    return yield* Agent.make({ system: "Reply.", tools: yield* Agent.tools([]), context })
  }))
  const timeoutRuntime = await Effect.runPromise(host(makeAssistant("stream-attempt-timeout"), { storage: join(storage, "timeout"), layer: timeoutModel }))
  let exhaustedCalls = 0
  const exhaustedModel = contentModelServices(() => {}, {
    request: { retry: { backoffMs: [0], retryAfterJitterMs: 0 }, timeout: { firstChunkMs: 150, idleMs: 150 } },
    stream: () => { exhaustedCalls++; return Stream.empty },
  })
  const exhaustedRuntime = await Effect.runPromise(host(makeAssistant("stream-budget-exhausted"), { storage: join(storage, "exhausted"), layer: exhaustedModel }))
  try {
    const timeoutThread = await Effect.runPromise(timeoutRuntime.allocateRootThread({ instance: "main", name: "thread" }))
    await Effect.runPromise(timeoutThread.invoke("message", { text: "Hello" }, { id: "timeout" }))
    expect((await Effect.runPromise(timeoutThread.result("message", "timeout"))).status).toBe("failed")
    expect(attemptTimeoutCalls).toBe(1)
    const timeoutRecords = await Effect.runPromise(timeoutThread.records())
    expect(timeoutRecords.filter(record => record.event.type === "RetryScheduled")).toHaveLength(0)

    const exhaustedThread = await Effect.runPromise(exhaustedRuntime.allocateRootThread({ instance: "main", name: "thread" }))
    await Effect.runPromise(exhaustedThread.invoke("message", { text: "Hello" }, { id: "exhausted" }))
    expect((await Effect.runPromise(exhaustedThread.result("message", "exhausted"))).status).toBe("failed")
    expect(exhaustedCalls).toBe(2)
    const exhaustedRecords = await Effect.runPromise(exhaustedThread.records())
    expect(exhaustedRecords.filter(record => record.event.type === "RetryScheduled")).toHaveLength(1)
  } finally {
    await Effect.runPromise(timeoutRuntime.close)
    await Effect.runPromise(exhaustedRuntime.close)
    await rm(storage, { recursive: true, force: true })
  }
})
