import { Duration, Effect, Random } from "effect"
import { AiError } from "effect/ai"
import type { RetryOptions } from "@clavia/tardigrade-core/services/effect-execution"
import { encodeModelError } from "@clavia/tardigrade-model/error"
import type { RetryPolicy } from "@clavia/tardigrade-model/stream/policy"
import { retryDelayOf } from "@clavia/tardigrade-model/stream/retry"

// modelRetry classifies provider failures before terminal error rendering.
export const modelRetry = (policy: RetryPolicy): RetryOptions<Error> => ({
  decide: (failure, attempt) => Effect.gen(function* () {
    let error: unknown = failure
    const seen = new Set<unknown>()
    while (error instanceof Error && !AiError.isAiError(error) && !seen.has(error)) { seen.add(error); error = error.cause }
    if (!AiError.isAiError(error) || !error.isRetryable) return undefined
    const retryAfterMs = error.retryAfter === undefined ? undefined : Duration.toMillis(error.retryAfter)
    const delayMs = retryDelayOf(policy, attempt, retryAfterMs, yield* Random.next)
    if (delayMs === undefined) return undefined
    return { delayMs, reason: { error: encodeModelError(error), policy, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } }
  }),
})
