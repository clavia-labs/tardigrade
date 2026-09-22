import { expect, test } from "bun:test"
import { AiError } from "effect/unstable/ai"
import { canFallback } from "./retry"

const denied = AiError.make({ module: "Provider", method: "streamText", reason: AiError.InvalidRequestError.make({ description: "Region unavailable" }) })

test("local validation, refusal, truncation, and unknown failures do not trigger fallback", () => {
  for (const error of [new Error("defect"), AiError.make({ module: "Provider", method: "streamText", reason: AiError.InvalidUserInputError.make({ description: "Invalid local tool configuration" }) })]) {
    expect(canFallback({ kind: "fail", error })).toBe(false)
  }
  for (const cause of ["output_unsupported", "output_limit", "refused", "model_selection"] as const) {
    expect(canFallback({ kind: "fail", error: denied, failure: { cause, attempts: 1 } })).toBe(false)
  }
  expect(canFallback({ kind: "fail", error: denied })).toBe(true)
})
