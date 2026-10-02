import { Clock, Data, Duration, Effect, Random, Schedule } from "effect"

export interface IoRetryPolicy {
  readonly maxAttempts: number
  readonly initialDelayMillis: number
  readonly maxDelayMillis: number
  readonly backoffFactor: number
  readonly jitter: number
  readonly attemptTimeoutMillis: number
  readonly totalTimeoutMillis: number
}

export const DEFAULT_IO_RETRY_POLICY: IoRetryPolicy = {
  maxAttempts: 5,
  initialDelayMillis: 250,
  maxDelayMillis: 5_000,
  backoffFactor: 2,
  jitter: 0.2,
  attemptTimeoutMillis: 10_000,
  totalTimeoutMillis: 60_000
}

// ioRetryPolicy validates the retry limits applied by the host.
export const ioRetryPolicy = (overrides: Partial<IoRetryPolicy> = {}): IoRetryPolicy => {
  const policy = { ...DEFAULT_IO_RETRY_POLICY, ...overrides }
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new Error("maxAttempts must be a positive safe integer")
  for (const key of ["initialDelayMillis", "maxDelayMillis", "attemptTimeoutMillis", "totalTimeoutMillis"] as const) {
    if (!Number.isFinite(policy[key]) || policy[key] < 0 || policy[key] > 2_147_483_647) throw new Error(`${key} must be between zero and the JavaScript timer maximum`)
  }
  if (policy.attemptTimeoutMillis === 0 || policy.totalTimeoutMillis === 0) throw new Error("retry timeouts must be positive")
  if (policy.maxDelayMillis < policy.initialDelayMillis) throw new Error("maxDelayMillis must be at least initialDelayMillis")
  if (!Number.isFinite(policy.backoffFactor) || policy.backoffFactor < 1) throw new Error("backoffFactor must be finite and at least one")
  if (!Number.isFinite(policy.jitter) || policy.jitter < 0 || policy.jitter > 1) throw new Error("jitter must be between zero and one")
  return policy
}

export interface IoFailureClassification {
  readonly classification: "transient" | "permanent" | "unknown"
  readonly retryAfterMillis?: number
}

export class IoTimeoutError extends Data.TaggedError("IoTimeoutError")<{
  readonly operation: string
  readonly phase: "attempt" | "total"
  readonly timeoutMillis: number
  readonly cause?: unknown
}> {
  override get message(): string { return `${this.operation}: ${this.phase} timeout after ${this.timeoutMillis}ms` }
}

// retryIo retries typed transient failures of a caller-selected replay-safe operation; interruption cannot cancel bindings that lack abort support.
export const retryIo = <A, E, R>(effect: Effect.Effect<A, E, R>, options: {
  readonly operation: string
  readonly classifyError: (error: E) => IoFailureClassification
  readonly policy?: Partial<IoRetryPolicy>
}): Effect.Effect<A, E | IoTimeoutError, R> => {
  const policy = ioRetryPolicy(options.policy)
  return Effect.suspend(() => {
    let attempts = 0
    let lastFailure: E | IoTimeoutError | undefined
    const classify = (error: E | IoTimeoutError): IoFailureClassification => error instanceof IoTimeoutError
      ? { classification: error.phase === "attempt" ? "transient" : "unknown" } : options.classifyError(error)
    const hintOf = (error: E | IoTimeoutError) => {
      const hint = classify(error).retryAfterMillis
      return hint !== undefined && Number.isFinite(hint) && hint >= 0 ? hint : 0
    }
    return Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      const base: Schedule.Schedule<Duration.Duration, E | IoTimeoutError> = Schedule.exponential(policy.initialDelayMillis, policy.backoffFactor)
      const schedule = base.pipe(
        Schedule.while(({ input }) => attempts < policy.maxAttempts && classify(input).classification === "transient"),
        Schedule.modifyDelay(({ input, duration }) => Effect.gen(function* () {
          const local = Math.min(Duration.toMillis(duration), policy.maxDelayMillis)
          const random = policy.jitter === 0 ? 1 : yield* Random.next
          return Math.max(local * (1 - policy.jitter + policy.jitter * random), hintOf(input))
        })),
        Schedule.while(({ duration }) => Clock.currentTimeMillis.pipe(Effect.map(now => Duration.toMillis(duration) < policy.totalTimeoutMillis - (now - started)))),
        Schedule.tap(({ duration }) => Effect.logWarning("Retrying external I/O", { operation: options.operation, attempt: attempts, nextAttempt: attempts + 1, maxAttempts: policy.maxAttempts, delayMillis: Duration.toMillis(duration) }))
      )
      const attempt = Effect.suspend(() => {
        attempts++
        return effect.pipe(Effect.timeoutOrElse({
          duration: policy.attemptTimeoutMillis,
          orElse: () => Effect.fail(new IoTimeoutError({ operation: options.operation, phase: "attempt", timeoutMillis: policy.attemptTimeoutMillis }))
        }))
      }).pipe(Effect.tapError(error => Effect.sync(() => { lastFailure = error })))
      return yield* attempt.pipe(Effect.retry(schedule))
    }).pipe(
      Effect.timeoutOrElse({ duration: policy.totalTimeoutMillis, orElse: () => Effect.fail(new IoTimeoutError({ operation: options.operation, phase: "total", timeoutMillis: policy.totalTimeoutMillis, cause: lastFailure })) }),
      Effect.tapError(error => Effect.logWarning("External I/O failed", { operation: options.operation, attempts, maxAttempts: policy.maxAttempts, error }))
    )
  })
}
