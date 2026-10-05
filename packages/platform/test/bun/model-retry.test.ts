import { test, expect } from "bun:test"
import { Duration, Effect } from "effect"
import { AiError } from "effect/unstable/ai"
import { RuntimeError } from "@clavia/tardigrade-core"
import { modelRetry } from "../../../agent/src/services/model-retry"

const failure = (reason: AiError.AiError["reason"]) => AiError.make({ module: "Fixture", method: "streamText", reason })

test("model retry translates provider classification and wait hints within its budget", async () => {
  const policy = { backoffMs: [0], retryAfterJitterMs: 0, maxRetryAfterMs: 100 }
  const retry = modelRetry(policy)
  const rateLimit = failure(AiError.RateLimitError.make({ retryAfter: Duration.millis(25) }))
  expect(await Effect.runPromise(retry.decide(new RuntimeError("wrapped provider failure", { cause: rateLimit }), 0))).toMatchObject({ delayMs: 25, reason: { policy, retryAfterMs: 25 } })
  for (const [error, attempt] of [
    [failure(AiError.AuthenticationError.make({ kind: "InvalidKey", description: "invalid credentials" })), 0],
    [failure(AiError.RateLimitError.make({ retryAfter: Duration.millis(101) })), 0],
    [rateLimit, 1],
  ] as const) expect(await Effect.runPromise(retry.decide(error, attempt))).toBeUndefined()
})
