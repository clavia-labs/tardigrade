import { describe, expect, test } from "bun:test"
import { APICallError } from "@ai-sdk/provider"
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Usage
} from "@ai-sdk/provider"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { MockLanguageModelV4 } from "ai/test"
import type { Action, ModelRequest } from "../infer"
import { modelInference } from "./model"

// The adapter's whole job, stated against a model rather than against a wire format: what a request
// carries, what a result becomes, and which failures earn another attempt, a journaled wait, or
// nothing. The SDK owns the bytes, so nothing here asserts on them.

const request: ModelRequest = {
  system: "",
  messages: [{ role: "user", content: "Find order 4182." }],
  tools: []
}

const tokens = (input: number, output: number): LanguageModelV4Usage => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, reasoning: 0, prediction: undefined }
}) as unknown as LanguageModelV4Usage

const answered = (
  content: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
) =>
  ({
    content,
    finishReason: { unified: "stop", raw: "stop" },
    usage: tokens(10, 4),
    warnings: [],
    ...extra
  }) as never

const provider = (
  doGenerate: LanguageModelV4["doGenerate"],
  options: Record<string, unknown> = {}
) =>
  modelInference({
    id: "test",
    provider: "test-gateway",
    model: "test-model",
    contextWindow: 1000,
    languageModel: new MockLanguageModelV4({ doGenerate }),
    ...options
  })

// The stub answers at once, so the only thing left to wait for is the backoff between attempts.
const settled = (action: Effect.Effect<Action>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.forkChild(action)
      for (let step = 0; step < 8; step += 1) {
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 minute")
      }
      return yield* Fiber.join(running)
    }).pipe(Effect.provide(TestClock.layer()))
  )

const apiError = (options: { status: number; retryable: boolean; headers?: Record<string, string> }) =>
  new APICallError({
    message: `upstream said ${options.status}`,
    url: "https://gateway.test",
    requestBodyValues: {},
    statusCode: options.status,
    isRetryable: options.retryable,
    ...(options.headers === undefined ? {} : { responseHeaders: options.headers })
  })

describe("what the request carries", () => {
  test("names the call with an idempotency key, so a retry is the same call", async () => {
    const seen: Array<LanguageModelV4CallOptions> = []
    const model = provider(async (options) => {
      seen.push(options)
      return answered([{ type: "text", text: "ok" }])
    })

    await settled(model.react(request, "m-1/infer/0"))

    expect(seen[0]?.headers?.["idempotency-key"]).toBe("m-1/infer/0")
  })

  test("carries per-request settings the projection chose", async () => {
    const seen: Array<LanguageModelV4CallOptions> = []
    const model = provider(async (options) => {
      seen.push(options)
      return answered([{ type: "text", text: "ok" }])
    })

    await settled(
      model.react(
        {
          ...request,
          options: {
            reasoning: "high",
            temperature: 0.2,
            maxOutputTokens: 512,
            providerOptions: { gateway: { only: ["bedrock"] } }
          }
        },
        "k"
      )
    )

    expect(seen[0]?.reasoning).toBe("high")
    expect(seen[0]?.temperature).toBe(0.2)
    expect(seen[0]?.maxOutputTokens).toBe(512)
    expect(seen[0]?.providerOptions).toEqual({ gateway: { only: ["bedrock"] } })
  })

  test("refuses a request past the window before it costs anything", async () => {
    let called = 0
    const model = provider(async () => {
      called += 1
      return answered([{ type: "text", text: "ok" }])
    })

    const result = await settled(
      model.react({ ...request, messages: [{ role: "user", content: "x".repeat(20_000) }] }, "k")
    )

    expect(result.kind).toBe("fail")
    expect(String((result as { error: string }).error)).toContain("context window")
    expect(called).toBe(0)
  })
})

describe("what a result becomes", () => {
  test("a tool call, with the assistant content kept as the continuation", async () => {
    const model = provider(async () =>
      answered([
        { type: "reasoning", text: "thinking", providerMetadata: { test: { signature: "sig-1" } } },
        { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: { id: "4182" } }
      ])
    )

    const result = await settled(model.react(request, "k"))

    expect(result).toMatchObject({ kind: "call", callId: "call-1", name: "lookup" })
    const carried = (result as { continuation?: { protocol: string; value: unknown } }).continuation
    expect(carried?.protocol).toBe("ai-sdk/v1")
    // The reasoning part and the state that proves it survive whole, which is what a later request
    // has to send back.
    expect(JSON.stringify(carried?.value)).toContain("sig-1")
  })

  test("more than one tool call fails and names the option that fixes it", async () => {
    const model = provider(async () =>
      answered([
        { type: "tool-call", toolCallId: "a", toolName: "lookup", input: {} },
        { type: "tool-call", toolCallId: "b", toolName: "lookup", input: {} }
      ])
    )

    const result = await settled(model.react(request, "k"))

    expect(result.kind).toBe("fail")
    expect(String((result as { error: string }).error)).toContain("routes option")
  })

  // The fragment is kept rather than discarded, so the turn continues from it instead of asking the
  // model to write the whole artifact again. The tokens were spent either way.
  test("an answer stopped at its ceiling is recorded, with the tokens it spent", async () => {
    const model = provider(async () =>
      answered([{ type: "text", text: "half a sen" }], {
        finishReason: { unified: "length", raw: "length" }
      })
    )

    const result = await settled(model.react(request, "k"))

    expect(result.kind).toBe("truncated")
    expect(result).toMatchObject({ text: "half a sen" })
    expect(result.usage).toMatchObject({ promptTokens: 10, completionTokens: 4 })
  })

  // A cut call is reported as itself. Folding it into the text would mean inventing a notation for
  // a partial call, and the model that reads the conversation back was trained on no such notation.
  test("a tool call cut before its arguments closed is recorded as the call it was", async () => {
    const model = provider(async () =>
      answered(
        [
          { type: "tool-call", toolCallId: "c-1", toolName: "write", input: '{"path":"a.md"}' }
        ],
        { finishReason: { unified: "length", raw: "length" } }
      )
    )

    const result = await settled(model.react(request, "k"))

    expect(result).toMatchObject({
      kind: "truncated",
      call: { name: "write" }
    })
  })

  // The window bounds what the model reads and what it writes together, so a request that fits only
  // by ignoring its own answer is refused before it is sent.
  test("refuses a request whose answer would not fit beside it", async () => {
    let called = false
    const model = provider(
      async () => {
        called = true
        return answered([{ type: "text", text: "ok" }])
      },
      // The prompt alone fits the 1000-token window. Its answer is what does not.
      { maxOutputTokens: 990 }
    )

    const result = await settled(model.react(request, "k"))

    expect(called).toBe(false)
    expect(result.kind).toBe("fail")
    expect(String((result as { error: string }).error)).toContain("reserved for the answer")
  })

  test("a reported cost is kept, and an unreported one is priced or left unknown", async () => {
    const reported = await settled(
      provider(async () =>
        answered([{ type: "text", text: "ok" }], { providerMetadata: { gateway: { cost: 0 } } })
      ).react(request, "k")
    )
    const priced = await settled(
      provider(async () => answered([{ type: "text", text: "ok" }]), {
        pricing: { promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 }
      }).react(request, "k")
    )
    const unknown = await settled(
      provider(async () => answered([{ type: "text", text: "ok" }])).react(request, "k")
    )

    // A provider that said zero means free. A provider that said nothing means unknown, and a price
    // table is what turns unknown into a figure.
    expect(reported.usage?.costUsd).toBe(0)
    expect(priced.usage?.costUsd).toBeCloseTo(10 * 0.001 + 4 * 0.002, 10)
    expect(unknown.usage?.costUsd).toBeUndefined()
  })
})

describe("which failures earn what", () => {
  test("a refusal is settled, because the answer would not change", async () => {
    let calls = 0
    const model = provider(async () => {
      calls += 1
      throw apiError({ status: 401, retryable: false })
    })

    const result = await settled(model.react(request, "k"))

    expect(result.kind).toBe("fail")
    expect(calls).toBe(1)
  })

  test("a busy gateway is retried in flight, and a later attempt answers", async () => {
    let calls = 0
    const model = provider(async () => {
      calls += 1
      if (calls < 3) throw apiError({ status: 503, retryable: true })
      return answered([{ type: "text", text: "ok" }])
    })

    const result = await settled(model.react(request, "k"))

    expect(result).toMatchObject({ kind: "complete", output: "ok" })
    expect(calls).toBe(3)
  })

  test("a failure that outlives its retries becomes a wait rather than a failure", async () => {
    const model = provider(async () => {
      throw apiError({ status: 503, retryable: true })
    })

    const result = await settled(model.react(request, "k"))

    // The turn journals this and the runtime wakes the session, so a queue outlives a restart.
    expect(result.kind).toBe("defer")
  })

  test("a Retry-After longer than a blip skips the in-flight retries and states its due time", async () => {
    let calls = 0
    const model = provider(async () => {
      calls += 1
      throw apiError({ status: 429, retryable: true, headers: { "retry-after": "600" } })
    })

    const result = await settled(model.react(request, "k"))

    expect(result).toMatchObject({ kind: "defer", retryAfterMs: 600_000 })
    // Waiting ten minutes inside the Effect would hold the turn open and lose the wait on a crash.
    expect(calls).toBe(1)
  })

  test("a Retry-After written as a date is read as one", async () => {
    const model = provider(async () => {
      throw apiError({
        status: 429,
        retryable: true,
        headers: { "retry-after": new Date(Date.now() + 300_000).toUTCString() }
      })
    })

    const result = await settled(model.react(request, "k"))

    expect(result.kind).toBe("defer")
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(250_000)
  })

  test("a gateway that goes quiet costs one timeout rather than the turn", async () => {
    let calls = 0
    const signals: Array<AbortSignal | undefined> = []
    const model = provider(
      async (options) => {
        calls += 1
        signals.push(options.abortSignal)
        return await new Promise<never>(() => {})
      },
      { retries: 0, timeout: "2 minutes" }
    )

    const result = await settled(model.react(request, "k"))

    expect(result.kind).toBe("defer")
    expect(calls).toBe(1)
    // The signal is what makes the interruption reach the gateway. An attempt only stopped being
    // awaited keeps running, the model finishes it, and the provider bills for it anyway.
    expect(signals[0]?.aborted).toBe(true)
  })

  test("a configuration error is settled before anything is sent", async () => {
    let calls = 0
    const model = provider(
      async () => {
        calls += 1
        return answered([{ type: "text", text: "ok" }])
      },
      { configurationError: "no account id" }
    )

    const result = await settled(model.react(request, "k"))

    expect(result).toMatchObject({ kind: "fail", error: "no account id" })
    expect(calls).toBe(0)
  })
})
