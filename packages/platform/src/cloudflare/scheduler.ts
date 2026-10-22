import type { DurableObjectStorage, DurableObjectTransaction } from "@cloudflare/workers-types"
import { Effect, Schema } from "effect"
import { RuntimeError, ScheduledWake, schedulerAlarm, type SchedulerStorage, type SchedulerTransaction } from "@clavia/tardigrade-core"
import { makeAlarmScheduling, type DurableObjectAlarmsOptions } from "@clavia/tardigrade-cloudflare/layers/alarms"

const prefix = "tardie:scheduler:"

// cloudflareSchedulerTransaction binds wake entries and the DO alarm to one commit.
export function cloudflareSchedulerTransaction(tx: DurableObjectTransaction, alarms?: DurableObjectAlarmsOptions): SchedulerTransaction {
  const io = <Value>(run: () => Promise<Value>) => Effect.tryPromise({ try: run, catch: RuntimeError.from })
  const scheduling = makeAlarmScheduling(tx, alarms)
  return {
    alarm: { set: at => scheduling.set(Math.max(1, at)), clear: scheduling.delete },
    allocateGeneration: Effect.gen(function* () {
      const stored = yield* io(() => tx.get("tardie:scheduler-generation"))
      const previous = yield* Schema.decodeUnknownEffect(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(Number.MAX_SAFE_INTEGER)))(stored ?? 0).pipe(Effect.mapError(RuntimeError.from))
      const next = previous + 1
      yield* io(() => tx.put("tardie:scheduler-generation", next))
      return next
    }),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: Missing scheduler entries require an undefined result.
    get: id => io(() => tx.get(prefix + id)).pipe(Effect.flatMap(value => value === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(ScheduledWake)(value).pipe(Effect.mapError(RuntimeError.from)))),
    put: entry => io(() => tx.put(prefix + entry.id, entry)),
    delete: id => io(() => tx.delete(prefix + id)).pipe(Effect.asVoid),
    list: io(() => tx.list({ prefix })).pipe(Effect.flatMap(entries => Effect.forEach(entries.values(), value => Schema.decodeUnknownEffect(ScheduledWake)(value).pipe(Effect.mapError(RuntimeError.from)))), Effect.map(entries => new Map(entries.map(entry => [entry.id, entry])))),
  }
}

// cloudflareSchedulerStorage commits durable wakes and flushes before acknowledging.
export const cloudflareSchedulerStorage = (storage: DurableObjectStorage, alarms?: DurableObjectAlarmsOptions): SchedulerStorage => ({
  transaction: work => Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    const result = yield* Effect.tryPromise({ try: () => storage.transaction(tx => {
      const scheduler = cloudflareSchedulerTransaction(tx, alarms)
      return Effect.runPromiseWith(context)(work(scheduler).pipe(Effect.tap(() => schedulerAlarm(scheduler))))
    }), catch: RuntimeError.from })
    yield* Effect.tryPromise({ try: () => storage.sync(), catch: RuntimeError.from })
    return result
  }).pipe(Effect.uninterruptible),
})
