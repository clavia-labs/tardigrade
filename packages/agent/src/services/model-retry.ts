import { Duration, Effect, Random, type Schema } from "effect"
import { AiError } from "effect/ai"
import { StreamTimedOut } from "@clavia/tardigrade-core"
import type { RetryOptions } from "@clavia/tardigrade-core/services/effect-execution"
import { encodeModelError } from "@clavia/tardigrade-model/error"
import type { RetryPolicy } from "@clavia/tardigrade-model/stream/policy"
import { StreamBoundExceeded, StreamIncomplete } from "@clavia/tardigrade-model/stream/request"
import { retryDelayOf } from "@clavia/tardigrade-model/stream/retry"

const streamFailureOf = (error: unknown): Schema.Json | undefined => {
  if (error instanceof StreamTimedOut) return { _tag: error._tag, bound: error.bound, timeoutMs: error.timeoutMs }
  if (error instanceof StreamIncomplete) return { _tag: error._tag }
  if (error instanceof StreamBoundExceeded && error.bound !== "attemptMs") return { _tag: error._tag, bound: error.bound }
  return undefined
}

// modelRetry classifies provider and stream transport failures before terminal error rendering.
export const modelRetry = (policy: RetryPolicy): RetryOptions<Error> => ({
  decide: (failure, attempt) => Effect.gen(function* () {
    let error: unknown = failure
    const seen = new Set<unknown>()
    while (error instanceof Error && !AiError.isAiError(error) && streamFailureOf(error) === undefined && !seen.has(error)) { seen.add(error); error = error.cause }
    const provider = AiError.isAiError(error) && error.isRetryable ? error : undefined
    const evidence = provider === undefined ? streamFailureOf(error) : encodeModelError(provider)
    if (evidence === undefined) return undefined
    const retryAfterMs = provider?.retryAfter === undefined ? undefined : Duration.toMillis(provider.retryAfter)
    const delayMs = retryDelayOf(policy, attempt, retryAfterMs, yield* Random.next)
    if (delayMs === undefined) return undefined
    return { delayMs, reason: { error: evidence, policy, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } }
  }),
})
