import { expect, test } from "bun:test"
import { Duration, Schema } from "effect"
import { AiError } from "effect/unstable/ai"
import { modelReturned, ModelReturned } from "../log/events"
import { modelErrorOf } from "./error"

test("native retry delay survives the ModelReturned JSON boundary", () => {
  const error = AiError.make({ module: "Fixture", method: "streamText", reason: AiError.RateLimitError.make({ retryAfter: Duration.millis(2000) }) })
  const stored = modelReturned({ callId: "a", ordinal: 0, turn: "t", outcome: "failed", usage: {}, error, at: 1 })
  const event = Schema.decodeUnknownSync(ModelReturned)(JSON.parse(JSON.stringify(stored)))
  const decoded = modelErrorOf(event.error)!
  expect(decoded.isRetryable).toBe(true)
  expect(Duration.toMillis(decoded.retryAfter!)).toBe(2000)
  expect(stored.error).not.toHaveProperty("message")
})
