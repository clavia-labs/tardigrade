import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import type { Action, ModelRequest } from "../infer"
import { openAiChatInference } from "./openai-chat"

// A gateway fails in two ways, and they earn opposite answers. A busy or broken gateway earns
// another attempt. A refusal earns none, because the same request refused once is refused again.
//
// The waiting between attempts is simulated. These tests walk a test clock forward rather than
// sleeping, so the backoff can be as long as production wants without costing the suite anything.

const request: ModelRequest = {
  system: "",
  messages: [{ role: "user", content: "Find order 4182." }],
  tools: []
}

const answer = JSON.stringify({
  choices: [{ message: { content: "Found it." } }],
  usage: { prompt_tokens: 10, completion_tokens: 4, cost_usd: 0.001 }
})

const provider = (stub: typeof fetch, options: { readonly retries?: number } = {}) =>
  openAiChatInference({
    id: "test",
    provider: "test-gateway",
    model: "test-model",
    contextWindow: 1000,
    endpoint: "https://gateway.test/v1/chat/completions",
    apiKey: "key",
    fetch: stub,
    ...options
  })

// The stub answers immediately, so the only thing left to wait for is the backoff. Walking the
// clock in steps lets each sleep be scheduled and then passed.
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

const responder = (statuses: ReadonlyArray<number>) => {
  const seen: Array<string> = []
  const stub = (async (_url: string, init: RequestInit) => {
    const status = statuses[seen.length] ?? 200
    seen.push(String(new Headers(init.headers).get("idempotency-key")))
    return new Response(status === 200 ? answer : `upstream said ${status}`, { status })
  }) as unknown as typeof fetch
  return { seen, stub }
}

describe("a transient failure", () => {
  test("is retried, and a later attempt answers", async () => {
    const gateway = responder([503, 429])
    const result = await settled(provider(gateway.stub).react(request, "turn/infer/0"))

    expect(result).toMatchObject({ kind: "complete", output: "Found it." })
    expect(gateway.seen).toHaveLength(3)
  })

  test("gives up once the retries are spent, and the reason survives", async () => {
    const gateway = responder([500, 500, 500, 500])
    const result = await settled(provider(gateway.stub).react(request, "turn/infer/0"))

    expect(result).toMatchObject({ kind: "fail" })
    expect(String((result as { error: string }).error)).toContain("HTTP 500")
    // The default is two further attempts, so a failing call is made three times and no more.
    expect(gateway.seen).toHaveLength(3)
  })

  test("carries one idempotency key across attempts, so a retry is the same call", async () => {
    const gateway = responder([503])
    await settled(provider(gateway.stub).react(request, "turn/infer/2"))

    expect(new Set(gateway.seen)).toEqual(new Set(["turn/infer/2"]))
  })

  test("a network failure is retried like a busy gateway", async () => {
    let attempts = 0
    const stub = (async () => {
      attempts += 1
      if (attempts < 3) throw new Error("connection reset")
      return new Response(answer, { status: 200 })
    }) as unknown as typeof fetch
    const result = await settled(provider(stub).react(request, "turn/infer/0"))

    expect(result).toMatchObject({ kind: "complete", output: "Found it." })
    expect(attempts).toBe(3)
  })
})

describe("a refusal", () => {
  test("is not retried, because the answer would not change", async () => {
    const gateway = responder([401, 200])
    const result = await settled(provider(gateway.stub).react(request, "turn/infer/0"))

    expect(result).toMatchObject({ kind: "fail" })
    expect(String((result as { error: string }).error)).toContain("HTTP 401")
    expect(gateway.seen).toHaveLength(1)
  })

  test("a body that is not JSON fails with what arrived", async () => {
    const stub = (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch
    const result = await settled(provider(stub).react(request, "turn/infer/0"))

    expect(String((result as { error: string }).error)).toContain("not JSON")
  })
})

describe("a silent gateway", () => {
  test("costs one timeout rather than the turn", async () => {
    let attempts = 0
    const stub = (async () => {
      attempts += 1
      // A gateway that accepts the request and never answers.
      return await new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    const result = await settled(provider(stub, { retries: 0 }).react(request, "turn/infer/0"))

    expect(result).toMatchObject({ kind: "fail" })
    expect(String((result as { error: string }).error)).toContain("timeout")
    expect(attempts).toBe(1)
  })
})
