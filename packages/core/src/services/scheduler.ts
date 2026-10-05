import { Clock, Context, Effect, Schema, Semaphore } from "effect"
import type { Alarm } from "./alarm"
import { RuntimeError } from "../runtime/effects"

export const DEFAULT_SCHEDULER_POLICY = { deliveryRetryMs: 1_000, deliveryTimeoutMs: 30_000 } as const
export interface SchedulerPolicy { readonly deliveryRetryMs: number; readonly deliveryTimeoutMs: number }

export const ScheduledWake = Schema.Struct({
  id: Schema.NonEmptyString,
  target: Schema.Json,
  dueAt: Schema.Finite,
  generation: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  nextWakeAt: Schema.Finite,
})
export type ScheduledWake = typeof ScheduledWake.Type
export type WakeRequest = Pick<ScheduledWake, "id" | "target" | "dueAt">

export interface SchedulerTransaction {
  readonly alarm: typeof Alarm.Service
  readonly allocateGeneration: Effect.Effect<number, Error>
  readonly get: (id: string) => Effect.Effect<ScheduledWake | undefined, Error>
  readonly put: (entry: ScheduledWake) => Effect.Effect<void, Error>
  readonly delete: (id: string) => Effect.Effect<void, Error>
  readonly list: Effect.Effect<ReadonlyMap<string, ScheduledWake>, Error>
}
export interface SchedulerStorage {
  // transaction synchronizes the physical alarm once after successful wake mutations.
  readonly transaction: <Value>(work: (tx: SchedulerTransaction) => Effect.Effect<Value, Error>) => Effect.Effect<Value, Error>
}

// Scheduler owns durable wake registration; hosts dispatch its wakes through their existing runtime.
export class Scheduler extends Context.Service<Scheduler, {
  readonly schedule: (request: WakeRequest) => Effect.Effect<void, Error>
  readonly cancel: (id: string) => Effect.Effect<void, Error>
  readonly restore: Effect.Effect<void, Error>
}>()("tardigrade/Scheduler") {}

// schedulerAlarm selects the earliest persisted wake within the caller's transaction.
export const schedulerAlarm = (tx: SchedulerTransaction) => Effect.gen(function* () {
  const entries = yield* tx.list
  let earliest: number | undefined
  for (const entry of entries.values()) earliest = earliest === undefined ? entry.nextWakeAt : Math.min(earliest, entry.nextWakeAt)
  yield* earliest === undefined ? tx.alarm.clear : tx.alarm.set(earliest)
})

// scheduleWake replaces a wake; its transaction boundary synchronizes the physical alarm.
export const scheduleWake = (tx: SchedulerTransaction, request: WakeRequest) => Effect.gen(function* () {
  const generation = yield* tx.allocateGeneration
  const entry = yield* Schema.decodeEffect(ScheduledWake)({ ...request, generation, nextWakeAt: request.dueAt }).pipe(Effect.mapError(RuntimeError.from))
  yield* tx.put(entry)
})

// cancelWake removes a wake; its transaction boundary preserves other owners' alarms.
export const cancelWake = (tx: SchedulerTransaction, id: string) => tx.delete(id)

// schedulerOwner adapts an owner's alarm to a named entry in a shared scheduler.
export const schedulerOwner = (tx: SchedulerTransaction, id: string, target: Schema.Json): typeof Alarm.Service => ({
  set: dueAt => scheduleWake(tx, { id, target, dueAt }),
  clear: cancelWake(tx, id),
})

// createScheduler retains unacknowledged wakes and protects replacements from stale acknowledgments (packages/platform/test/properties/scheduler/wakes.ts).
export function createScheduler(options: {
  readonly storage: SchedulerStorage
  readonly deliver: (wake: ScheduledWake) => Effect.Effect<void, Error>
  readonly policy?: Partial<SchedulerPolicy> | undefined
}) {
  const policy = { ...DEFAULT_SCHEDULER_POLICY, ...options.policy }
  for (const [key, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new RuntimeError(`Scheduler ${key} must be a positive safe integer`)
  const lock = Semaphore.makeUnsafe(1)
  return {
    policy,
    schedule: (request: WakeRequest) => options.storage.transaction(tx => scheduleWake(tx, request)),
    cancel: (id: string) => options.storage.transaction(tx => cancelWake(tx, id)),
    restore: options.storage.transaction(() => Effect.void),
    alarm: lock.withPermit(Effect.gen(function* () {
      const entries = yield* options.storage.transaction(tx => tx.list)
      for (const entry of entries.values()) {
        const claimed = yield* options.storage.transaction(tx => Effect.gen(function* () {
          const current = yield* tx.get(entry.id)
          const now = yield* Clock.currentTimeMillis
          if (!current || current.generation !== entry.generation || current.nextWakeAt > now) return undefined
          yield* tx.put({ ...current, nextWakeAt: now + policy.deliveryRetryMs })
          return current
        }))
        if (!claimed) continue
        const result = yield* Effect.exit(options.deliver(claimed).pipe(Effect.timeout(policy.deliveryTimeoutMs)))
        yield* options.storage.transaction(tx => Effect.gen(function* () {
          const current = yield* tx.get(claimed.id)
          if (result._tag === "Success" && current?.generation === claimed.generation) yield* tx.delete(claimed.id)
        }))
      }
    })),
  }
}
