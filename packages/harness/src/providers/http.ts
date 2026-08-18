import { Duration, Effect, Schedule } from "effect"
import { estimateTextTokens } from "../context"
import type { Action } from "../infer"

// What every provider in this package shares: how a request is attempted, how long one attempt may
// take, which failures earn another, and how a request too large for the model is refused before it
// costs anything. A second copy of these rules would drift from the first, and the drift would show
// up as a gateway that retries a refusal or bills twice for one turn.

// A failure worth another attempt: the connection broke, or the gateway is busy or briefly unwell.
// A refusal is not one of these. A request refused for a bad key or a malformed body is refused the
// same way every time, so retrying it spends money and time to learn nothing.
interface Transient {
  readonly reason: string
  readonly retryAfterMs?: number
}

const RETRYABLE = new Set([408, 409, 425, 429])

const isTransient = (status: number) => status >= 500 || RETRYABLE.has(status)

const DEFAULT_RETRIES = 2

// A Retry-After of more than two seconds is a queue, not a blip. Honouring it inside this Effect
// would hold the turn open for the wait, and a crash would lose it. Returning it on the action lets
// the log record the due time and the runtime wake the session.
const QUEUE_RETRY_AFTER_MS = 2_000

const retryAfterMsOf = (header: string | null) => {
  if (header === null || header === "") return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  return undefined
}

// How long one attempt may take before this side stops waiting. It is a guard against a socket that
// has gone quiet, so it sits well outside the range where real answers land: a reasoning model
// thinking for two minutes is working, and a connection silent for ten is hung. A bound inside that
// range discards answers that were on their way, which is the failure this number is set to avoid
// rather than the one it is set to cause. `timeout` moves it.
const DEFAULT_TIMEOUT: Duration.Input = "10 minutes"

// Waiting longer each time is what makes a retry useful to a gateway that is shedding load, and the
// jitter is what stops a fleet of agents that failed together from returning together.
const backoff = Schedule.exponential("500 millis").pipe(Schedule.jittered)

// The one maximum a provider states: how large a request the model accepts. It is a bound on the
// whole request rather than on any one message, so this is where it is checked, and nothing upstream
// invents a per-message limit to approximate it.
//
// A request past the window can not succeed, so sending it buys a slow refusal in the gateway's
// words. Refusing here spends nothing and answers in the harness's own words, naming both sizes and
// the model they belong to.
export const overWindow = (
  body: string,
  provider: string,
  model: string,
  window: number
): Action | undefined => {
  const estimate = estimateTextTokens(body)
  if (estimate <= window) return undefined
  return {
    kind: "fail",
    error:
      `this request is at least ${estimate} tokens and ${provider} reports a context window of ` +
      `${window} tokens for ${model}, so the model can not read it. Pass contextWindow to override ` +
      "what the model accepts, bound what reaches the model with messageTruncateAt and " +
      "resultTruncateAt, or send less."
  }
}

export interface Attempt {
  readonly call: typeof fetch
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly provider: string
  readonly retries?: number
  readonly timeout?: Duration.Input
  // What the provider makes of a body the gateway accepted. Reading the wire format is the one part
  // of a request that belongs to the provider rather than here.
  readonly read: (body: unknown) => Action
}

// The request, its retries, and the one outcome they settle on.
export const sent = (attempt: Attempt) => {
  const failed = (reason: string, retryAfterMs?: number): Transient => ({
    reason,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  })
  const one = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      // The signal is what makes an interruption reach the gateway. Without it, a timed-out attempt
      // stops being awaited and keeps running: the model finishes, the provider bills for it, and
      // the retry asks for the same completion again. Every attempt after the first was then paid
      // for twice for a turn that recorded a failure.
      try: (signal) =>
        attempt.call(attempt.endpoint, {
          method: "POST",
          headers: attempt.headers,
          body: attempt.body,
          signal
        }),
      catch: (error) => failed(error instanceof Error ? error.message : String(error))
    })
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => failed(error instanceof Error ? error.message : String(error))
    })
    if (!response.ok) {
      const reason = `${attempt.provider} returned HTTP ${response.status}: ${text}`
      const retryAfterMs = retryAfterMsOf(response.headers.get("retry-after"))
      if (isTransient(response.status)) {
        if (retryAfterMs !== undefined && retryAfterMs > QUEUE_RETRY_AFTER_MS) {
          return {
            kind: "defer",
            error: reason,
            retryAfterMs
          } satisfies Action
        }
        return yield* Effect.fail(failed(reason, retryAfterMs))
      }
      return { kind: "fail", error: reason } satisfies Action
    }
    try {
      return attempt.read(JSON.parse(text) as unknown)
    } catch {
      return {
        kind: "fail",
        error: `${attempt.provider} returned a body that is not JSON: ${text}`
      } satisfies Action
    }
  })
  return one.pipe(
    // The bound is on one attempt rather than the whole retry, so a gateway that accepts a
    // request and then goes quiet costs one timeout rather than the turn.
    Effect.timeoutOrElse({
      duration: attempt.timeout ?? DEFAULT_TIMEOUT,
      orElse: () => Effect.fail(failed("no response within the request timeout"))
    }),
    Effect.retry({ schedule: backoff, times: attempt.retries ?? DEFAULT_RETRIES }),
    // A failure that outlived its retries is still transient: the log records a deferral and the
    // runtime wakes the session at the due time, so a restart can wait out the queue.
    Effect.catch((failure) =>
      Effect.succeed({
        kind: "defer",
        error: `${attempt.provider} request failed: ${failure.reason}`,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs })
      } satisfies Action)
    ),
    Effect.catchDefect((defect) =>
      Effect.succeed({
        kind: "fail",
        error: `${attempt.provider} request failed: ${String(defect)}`
      } satisfies Action)
    )
  )
}
