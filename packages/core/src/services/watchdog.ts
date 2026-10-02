import { Cause, Clock, Effect, Exit, Schema, Semaphore } from "effect"
import { RuntimeError } from "../runtime/effects"
import type { Alarm } from "./alarm"

export const DEFAULT_WATCHDOG_POLICY = { attemptTimeoutMs: 30_000, keepAliveIntervalMs: 30_000, retryIntervalMs: 1_000, maxRetryIntervalMs: 30_000, maxAttempts: 20, maxNoProgressAttempts: 5 } as const
export interface WatchdogPolicy { readonly attemptTimeoutMs: number; readonly keepAliveIntervalMs: number; readonly retryIntervalMs: number; readonly maxRetryIntervalMs: number; readonly maxAttempts: number; readonly maxNoProgressAttempts: number }

// watchdogPolicy validates host recovery budgets and scheduling bounds.
export function watchdogPolicy(overrides: Partial<WatchdogPolicy> = {}): WatchdogPolicy {
  const policy = { ...DEFAULT_WATCHDOG_POLICY, ...overrides }
  for (const [key, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new RuntimeError(`Watchdog ${key} must be a positive safe integer`)
  if (policy.maxRetryIntervalMs < policy.retryIntervalMs) throw new RuntimeError("Watchdog maxRetryIntervalMs must be at least retryIntervalMs")
  return policy
}

export const WatchdogTarget = Schema.Struct({ actor: Schema.NonEmptyString, instance: Schema.NonEmptyString, thread: Schema.optionalKey(Schema.NonEmptyString) })
export type WatchdogTarget = typeof WatchdogTarget.Type
export const WatchdogEntry = Schema.Struct({ target: WatchdogTarget, generation: Schema.Int, budgetGeneration: Schema.optionalKey(Schema.Int), progressCursor: Schema.Int, attempts: Schema.Int, consecutiveNoProgress: Schema.Int, nextWakeAt: Schema.NullOr(Schema.Finite), status: Schema.Literals(["pending", "blocked"]), reason: Schema.optionalKey(Schema.String) })
export type WatchdogEntry = typeof WatchdogEntry.Type
export interface RecoveryState { readonly progressCursor: number; readonly status: "settled" | "pending" | "parked" | "running"; readonly wakeAt?: number }
export interface WatchdogTransaction {
  readonly alarm: typeof Alarm.Service
  readonly get: (key: string) => Effect.Effect<WatchdogEntry | undefined, Error>
  readonly put: (key: string, entry: WatchdogEntry) => Effect.Effect<void, Error>
  readonly delete: (key: string) => Effect.Effect<void, Error>
  readonly list: Effect.Effect<ReadonlyMap<string, WatchdogEntry>, Error>
}
export interface WatchdogStorage {
  readonly transaction: <Value>(work: (tx: WatchdogTransaction) => Effect.Effect<Value, Error>) => Effect.Effect<Value, Error>
}

// WatchdogTerminalError blocks automatic recovery until an explicit resume.
export class WatchdogTerminalError extends Error { readonly _tag = "WatchdogTerminalError" }
export const watchdogKey = (target: WatchdogTarget) => JSON.stringify([target.actor, target.instance, target.thread ?? null])

// createWatchdog precharges durable attempts before recovery (packages/platform/quint/recoveryBudget.qnt, boundedAttempts).
export function createWatchdog(options: {
  readonly storage: WatchdogStorage
  readonly recover: (target: WatchdogTarget) => Effect.Effect<RecoveryState, Error>
  readonly invalidate: (target: WatchdogTarget) => Effect.Effect<void, Error>
  readonly policy?: Partial<WatchdogPolicy>
  readonly retryable?: (error: Error) => boolean
  readonly probe?: (target: WatchdogTarget) => Effect.Effect<RecoveryState | undefined, Error>
  readonly launch?: (work: Effect.Effect<void, Error>) => Effect.Effect<void, Error>
}) {
  const policy = watchdogPolicy(options.policy)
  const lock = Semaphore.makeUnsafe(1)
  const cleanupLock = Semaphore.makeUnsafe(1)
  const active = new Map<string, { readonly expires: number }>()
  const schedule = (tx: WatchdogTransaction) => Effect.gen(function* () {
    const entries = yield* tx.list
    const now = yield* Clock.currentTimeMillis
    const times = [...entries.entries()].flatMap(([key, entry]) => {
      if (entry.status !== "pending" || entry.nextWakeAt === null) return []
      const expires = active.get(key)?.expires
      return [expires === undefined ? entry.nextWakeAt : Math.min(expires > now ? expires : now + policy.keepAliveIntervalMs, now + policy.keepAliveIntervalMs)]
    })
    yield* times.length ? tx.alarm.set(Math.min(...times)) : tx.alarm.clear
  })
  const admit = (tx: WatchdogTransaction, target: WatchdogTarget, progressCursor = 0, admission = true) => Effect.gen(function* () {
    const key = watchdogKey(target)
    const previous = yield* tx.get(key)
    const now = yield* Clock.currentTimeMillis
    yield* tx.put(key, previous
      ? { ...previous, generation: previous.generation + (admission ? 1 : 0), progressCursor: Math.max(previous.progressCursor, progressCursor), consecutiveNoProgress: progressCursor > previous.progressCursor ? 0 : previous.consecutiveNoProgress, ...(previous.status === "blocked" ? {} : { nextWakeAt: admission ? Math.min(previous.nextWakeAt ?? now, now) : previous.nextWakeAt ?? now }) }
      : { target, generation: 1, progressCursor, attempts: 0, consecutiveNoProgress: 0, nextWakeAt: now, status: "pending" })
    yield* schedule(tx)
  })
  const retryDelay = (failures: number) => Math.min(policy.maxRetryIntervalMs, policy.retryIntervalMs * 2 ** Math.min(Math.ceil(Math.log2(policy.maxRetryIntervalMs / policy.retryIntervalMs)), Math.max(0, failures - 1)))
  const finish = (key: string, covered: WatchdogEntry, result: Exit.Exit<RecoveryState, Error>, charged = true) => options.storage.transaction(tx => Effect.gen(function* () {
    const current = yield* tx.get(key)
    if (!current || current.status === "blocked" || (current.budgetGeneration ?? 0) !== (covered.budgetGeneration ?? 0)) { yield* schedule(tx); return }
    const now = yield* Clock.currentTimeMillis
    if (Exit.isSuccess(result)) {
      const state = result.value
      const progressCursor = Math.max(current.progressCursor, state.progressCursor)
      const progress = progressCursor > covered.progressCursor
      if (state.status === "settled" && current.generation === covered.generation) yield* tx.delete(key)
      else if ((state.status === "parked" || state.status === "running") && state.wakeAt !== undefined && state.wakeAt > now && current.generation === covered.generation) {
        yield* tx.put(key, { ...current, progressCursor, consecutiveNoProgress: progress ? 0 : Math.max(0, current.consecutiveNoProgress - (charged ? 1 : 0)), nextWakeAt: state.status === "running" ? Math.min(state.wakeAt, now + policy.keepAliveIntervalMs) : state.wakeAt })
      } else if (current.attempts >= policy.maxAttempts || (!progress && current.consecutiveNoProgress >= policy.maxNoProgressAttempts)) {
        yield* tx.put(key, { ...current, progressCursor, status: "blocked", nextWakeAt: null, reason: "Recovery budget exhausted" })
      } else yield* tx.put(key, { ...current, progressCursor, consecutiveNoProgress: progress ? 0 : current.consecutiveNoProgress, nextWakeAt: now + (progress ? policy.retryIntervalMs : retryDelay(current.consecutiveNoProgress)) })
    } else {
      const cause = Cause.squash(result.cause)
      const error = cause instanceof Error ? cause : RuntimeError.from(cause)
      const terminal = Cause.hasDies(result.cause) || (options.retryable ? !options.retryable(error) : error instanceof WatchdogTerminalError)
      const exhausted = current.attempts >= policy.maxAttempts || current.consecutiveNoProgress >= policy.maxNoProgressAttempts
      yield* tx.put(key, { ...current, status: terminal || exhausted ? "blocked" : "pending", nextWakeAt: terminal || exhausted ? null : now + retryDelay(current.consecutiveNoProgress), reason: error.message })
    }
    yield* schedule(tx)
  }))
  return {
    policy,
    admit,
    status: options.storage.transaction(tx => tx.list),
    resume: (target: WatchdogTarget) => cleanupLock.withPermit(options.storage.transaction(tx => Effect.gen(function* () {
      const key = watchdogKey(target)
      const current = yield* tx.get(key)
      if (!current) return
      yield* tx.put(key, { target: current.target, generation: current.generation + 1, budgetGeneration: (current.budgetGeneration ?? 0) + 1, progressCursor: current.progressCursor, attempts: 0, consecutiveNoProgress: 0, status: "pending", nextWakeAt: yield* Clock.currentTimeMillis })
      yield* schedule(tx)
    }))),
    alarm: lock.withPermit(Effect.gen(function* () {
      const entries = yield* options.storage.transaction(tx => tx.list)
      for (const [key, entry] of entries) {
        const now = yield* Clock.currentTimeMillis
        if (active.has(key)) { yield* options.storage.transaction(schedule); continue }
        if (entry.status !== "pending" || entry.nextWakeAt === null || entry.nextWakeAt > now) continue
        const observed = options.probe ? yield* Effect.exit(options.probe(entry.target)) : Exit.succeed(undefined)
        if (Exit.isSuccess(observed) && observed.value && (observed.value.status === "settled" || ((observed.value.status === "running" || observed.value.status === "parked") && observed.value.wakeAt !== undefined && observed.value.wakeAt > now))) {
          yield* finish(key, entry, Exit.succeed(observed.value), false)
          continue
        }
        const covered = yield* options.storage.transaction(tx => Effect.gen(function* () {
          const entry = yield* tx.get(key)
          const now = yield* Clock.currentTimeMillis
          if (!entry || entry.status !== "pending" || entry.nextWakeAt === null || entry.nextWakeAt > now) { yield* schedule(tx); return undefined }
          if (entry.attempts >= policy.maxAttempts || entry.consecutiveNoProgress >= policy.maxNoProgressAttempts) {
            yield* tx.put(key, { ...entry, status: "blocked", nextWakeAt: null, reason: "Recovery budget exhausted" })
            yield* schedule(tx)
            return undefined
          }
          const next = { ...entry, attempts: entry.attempts + 1, consecutiveNoProgress: entry.consecutiveNoProgress + 1, nextWakeAt: now + policy.attemptTimeoutMs }
          yield* tx.put(key, next)
          yield* schedule(tx)
          return next
        }))
        if (!covered) continue
        const attempt = { expires: covered.nextWakeAt! }
        const release = () => { if (active.get(key) === attempt) active.delete(key) }
        const work = Effect.gen(function* () {
          const result = Exit.isFailure(observed) ? Exit.failCause(observed.cause) : yield* Effect.exit(options.recover(covered.target).pipe(Effect.timeout(policy.attemptTimeoutMs)))
          if (Exit.isFailure(result)) yield* cleanupLock.withPermit(Effect.gen(function* () {
            const current = yield* options.storage.transaction(tx => tx.get(key))
            if (current && (current.budgetGeneration ?? 0) === (covered.budgetGeneration ?? 0)) yield* options.invalidate(covered.target)
          }))
          release()
          yield* finish(key, covered, result)
        })
        if (options.launch) {
          active.set(key, attempt)
          yield* options.storage.transaction(schedule).pipe(
            Effect.andThen(options.launch(work.pipe(Effect.ensuring(Effect.sync(release))))),
            Effect.onError(() => Effect.sync(release)),
          )
        } else yield* work
      }
    })),
  }
}
