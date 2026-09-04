import { Clock, Effect, Random } from "effect"
import type { ActorInvocation } from "@clavia/tardigrade-core/method"
import type { Event } from "@clavia/tardigrade-core/event"
import { effect } from "@clavia/tardigrade-core/effect"
import { intent } from "@clavia/tardigrade-core/intent"
import { EventLog, type KeyFragment } from "@clavia/tardigrade-core/log"
import type { Projection } from "@clavia/tardigrade-core/projection"
import type { Transition } from "@clavia/tardigrade-core/transition"

// AttemptPolicy bounds the physical attempts, retry waits, and optional elapsed time for one operation.
export interface AttemptPolicy {
  readonly giveUpAfter: number
  readonly backoffMs: ReadonlyArray<number>
  readonly deadlineMs?: number
}

// DEFAULT_ATTEMPT_POLICY permits three physical attempts with a visible full-jitter backoff ladder.
export const DEFAULT_ATTEMPT_POLICY: AttemptPolicy = {
  giveUpAfter: 3,
  backoffMs: [2_000, 8_000, 30_000]
}

// AttemptStarted records a physical attempt before external work begins.
export interface AttemptStarted extends Event {
  readonly type: "AttemptStarted"
  readonly operation: string
  readonly attempt: number
  readonly deadlineAt?: number
  readonly at: number
}

// AttemptFailed records a typed failure and the earliest time of the next physical attempt.
export interface AttemptFailed extends Event {
  readonly type: "AttemptFailed"
  readonly operation: string
  readonly attempt: number
  readonly error: string
  readonly retryAt: number
  readonly at: number
}

// AttemptsExhausted records the terminal policy outcome for an operation.
export interface AttemptsExhausted extends Event {
  readonly type: "AttemptsExhausted"
  readonly operation: string
  readonly attempts: number
  readonly cause: "attempts_exhausted" | "deadline"
  readonly policy: AttemptPolicy
  readonly error?: string
  readonly at: number
}

// attemptKeys maps attempt evidence to occurrence keys and exhaustion to the operation key.
export const attemptKeys: KeyFragment = {
  prefixes: ["att:", "attf:"],
  keyOf: (event) => {
    if (event.type === "AttemptStarted") {
      const started = event as Partial<AttemptStarted>
      return typeof started.operation === "string" && Number.isSafeInteger(started.attempt)
        ? `att:${started.operation}/${started.attempt}`
        : undefined
    }
    if (event.type === "AttemptFailed") {
      const failed = event as Partial<AttemptFailed>
      return typeof failed.operation === "string" && Number.isSafeInteger(failed.attempt)
        ? `attf:${failed.operation}/${failed.attempt}`
        : undefined
    }
    if (event.type === "AttemptsExhausted") {
      const exhausted = event as Partial<AttemptsExhausted>
      return typeof exhausted.operation === "string" ? exhausted.operation : undefined
    }
    return undefined
  }
}

// AttemptRecord summarizes durable attempt evidence for one operation.
export interface AttemptRecord {
  readonly attempts: number
  readonly failures: number
  readonly lastError?: string
  readonly retryAt?: number
  readonly deadlineAt?: number
  readonly exhausted: boolean
}

// AttemptsState stores projected attempt records by operation key.
export type AttemptsState = ReadonlyMap<string, AttemptRecord>

const emptyAttemptRecord = (): AttemptRecord => ({ attempts: 0, failures: 0, exhausted: false })

// attemptsProjection derives attempt state by operation.
export const attemptsProjection: Projection<AttemptsState, (operation: string) => AttemptRecord> = {
  initial: () => new Map(),
  step: (state, event) => {
    if (event.type !== "AttemptStarted" && event.type !== "AttemptFailed" && event.type !== "AttemptsExhausted") {
      return state
    }
    const operation = (event as { readonly operation?: unknown }).operation
    if (typeof operation !== "string") return state
    const current = state.get(operation) ?? emptyAttemptRecord()
    let next: AttemptRecord
    if (event.type === "AttemptStarted") {
      const started = event as AttemptStarted
      if (!Number.isSafeInteger(started.attempt) || started.attempt < 0) return state
      next = {
        ...current,
        attempts: Math.max(current.attempts, started.attempt + 1),
        ...(current.deadlineAt !== undefined || started.deadlineAt === undefined
          ? {}
          : { deadlineAt: started.deadlineAt })
      }
    } else if (event.type === "AttemptFailed") {
      const failed = event as AttemptFailed
      if (!Number.isSafeInteger(failed.attempt) || failed.attempt < 0) return state
      next = {
        ...current,
        failures: current.failures + 1,
        lastError: failed.error,
        retryAt: failed.retryAt
      }
    } else {
      const exhausted = event as AttemptsExhausted
      next = {
        ...current,
        attempts: Math.max(current.attempts, exhausted.attempts),
        exhausted: true,
        ...(exhausted.error === undefined ? {} : { lastError: exhausted.error })
      }
    }
    const records = new Map(state)
    records.set(operation, next)
    return records
  },
  output: (state) => (operation) => state.get(operation) ?? emptyAttemptRecord()
}

const policyOf = (override?: Partial<AttemptPolicy>): AttemptPolicy => {
  const policy: AttemptPolicy = {
    giveUpAfter: override?.giveUpAfter ?? DEFAULT_ATTEMPT_POLICY.giveUpAfter,
    backoffMs: override?.backoffMs ?? DEFAULT_ATTEMPT_POLICY.backoffMs,
    ...(override?.deadlineMs === undefined ? {} : { deadlineMs: override.deadlineMs })
  }
  if (!Number.isSafeInteger(policy.giveUpAfter) || policy.giveUpAfter < 1) {
    throw new Error("attempt giveUpAfter must be a positive safe integer")
  }
  if (policy.backoffMs.length === 0 || policy.backoffMs.some((delay) =>
    !Number.isSafeInteger(delay) || delay < 0
  )) {
    throw new Error("attempt backoffMs must contain non-negative safe integers")
  }
  if (policy.deadlineMs !== undefined && (!Number.isSafeInteger(policy.deadlineMs) || policy.deadlineMs < 1)) {
    throw new Error("attempt deadlineMs must be a positive safe integer")
  }
  return { ...policy, backoffMs: [...policy.backoffMs] }
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

const abortController = (): AbortController => new AbortController()

const exhaustedEvent = (
  operation: string,
  attempts: number,
  cause: AttemptsExhausted["cause"],
  policy: AttemptPolicy,
  error: string | undefined,
  at: number
): AttemptsExhausted => ({
  type: "AttemptsExhausted",
  operation,
  attempts,
  cause,
  policy,
  ...(error === undefined ? {} : { error }),
  at
})

// AttemptWork describes one retryable operation and its visible policy.
export interface AttemptWork<Input, Failure, Requirements> {
  readonly operation: string
  readonly input: Input
  readonly policy?: Partial<AttemptPolicy>
  readonly concurrent?: boolean
  readonly invocation?: ActorInvocation
  readonly interrupts?: (input: Input, event: Event) => boolean
  readonly act: (
    input: Input,
    signal: AbortSignal
  ) => Effect.Effect<ReadonlyArray<Event>, Failure, EventLog | Requirements>
}

// attempted derives the next physical attempt or the operation's exhausted terminal.
export const attempted = <Input, Failure, Requirements = never>(
  record: AttemptRecord,
  work: AttemptWork<Input, Failure, Requirements>
): ReadonlyArray<Transition<never, Requirements>> => {
  const policy = policyOf(work.policy)
  if (record.exhausted) return []
  if (record.attempts >= policy.giveUpAfter) {
    return [intent({
      key: work.operation,
      input: undefined,
      events: (_, at) => [exhaustedEvent(
        work.operation,
        record.attempts,
        "attempts_exhausted",
        policy,
        record.lastError,
        at
      )]
    })]
  }
  const attempt = record.attempts
  return [effect<Input, Requirements>({
    key: `att:${work.operation}/${attempt}`,
    ...(work.concurrent === undefined ? {} : { concurrent: work.concurrent }),
    ...(work.invocation === undefined ? {} : { invocation: work.invocation }),
    input: work.input,
    ...(work.interrupts === undefined ? {} : { interrupts: work.interrupts }),
    act: (input, signal) => Effect.gen(function* () {
      const log = yield* EventLog
      const wakeAt = record.retryAt === undefined
        ? record.deadlineAt
        : record.deadlineAt === undefined
          ? record.retryAt
          : Math.min(record.retryAt, record.deadlineAt)
      const beforeWait = yield* Clock.currentTimeMillis
      if (wakeAt !== undefined && wakeAt > beforeWait) yield* Effect.sleep(wakeAt - beforeWait)
      const at = yield* Clock.currentTimeMillis
      if (record.deadlineAt !== undefined && at >= record.deadlineAt) {
        return [exhaustedEvent(
          work.operation,
          record.attempts,
          "deadline",
          policy,
          record.lastError,
          at
        )]
      }
      const deadlineAt = record.deadlineAt ??
        (policy.deadlineMs === undefined ? undefined : at + policy.deadlineMs)
      yield* log.append([{
        type: "AttemptStarted",
        operation: work.operation,
        attempt,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        at
      } satisfies AttemptStarted])
      const deadlineController = abortController()
      const workSignal = deadlineAt === undefined
        ? signal
        : AbortSignal.any([signal, deadlineController.signal])
      const run = work.act(input, workSignal).pipe(
        Effect.catch((error) => Effect.gen(function* () {
          const failedAt = yield* Clock.currentTimeMillis
          const base = policy.backoffMs[Math.min(attempt, policy.backoffMs.length - 1)]!
          const retryAt = failedAt + Math.floor((yield* Random.next) * base)
          return [{
            type: "AttemptFailed",
            operation: work.operation,
            attempt,
            error: errorText(error),
            retryAt,
            at: failedAt
          } satisfies AttemptFailed]
        }))
      )
      if (deadlineAt === undefined) return yield* run
      const timeout = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (deadlineAt > now) yield* Effect.sleep(deadlineAt - now)
        deadlineController.abort()
        return [exhaustedEvent(
          work.operation,
          attempt + 1,
          "deadline",
          policy,
          record.lastError,
          yield* Clock.currentTimeMillis
        )]
      })
      return yield* Effect.raceFirst(run, timeout)
    })
  })]
}
