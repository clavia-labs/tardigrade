import type { DurableObjectStorage, DurableObjectTransaction } from "@cloudflare/workers-types"
import { Effect, Schema } from "effect"
import { RuntimeError, WatchdogEntry, type WatchdogTransaction, type WatchdogStorage } from "@clavia/tardigrade-core"
import { makeAlarmScheduling, type DurableObjectAlarmsOptions } from "@clavia/tardigrade-cloudflare/layers/alarms"

const prefix = "tardie:watchdog:"

// cloudflareWatchdogTransaction binds recovery records and alarm changes to a DO transaction.
export function cloudflareWatchdogTransaction(tx: DurableObjectTransaction, alarms?: DurableObjectAlarmsOptions): WatchdogTransaction {
  const io = <Value>(run: () => Promise<Value>) => Effect.tryPromise({ try: run, catch: RuntimeError.from })
  const scheduling = makeAlarmScheduling(tx, alarms)
  return {
    alarm: { set: at => scheduling.set(at), clear: scheduling.delete },
    // get preserves the storage API's missing-value result.
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: WatchdogTransaction.get requires an undefined value.
    get: key => io(() => tx.get(prefix + key)).pipe(Effect.flatMap(value => value === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(WatchdogEntry)(value))),
    put: (key, entry) => Schema.decodeEffect(WatchdogEntry)(entry).pipe(Effect.flatMap(value => io(() => tx.put(prefix + key, value)))),
    delete: key => io(() => tx.delete(prefix + key)).pipe(Effect.asVoid),
    list: io(() => tx.list({ prefix })).pipe(Effect.flatMap(entries => Effect.forEach(entries, ([key, value]) => Schema.decodeUnknownEffect(WatchdogEntry)(value).pipe(Effect.map(entry => [key.slice(prefix.length), entry] as const)))), Effect.map(entries => new Map(entries))),
  }
}

// cloudflareWatchdogStorage commits recovery records and alarm changes atomically (test/workerd/watchdog.workers.ts).
export function cloudflareWatchdogStorage(storage: DurableObjectStorage, alarms?: DurableObjectAlarmsOptions): WatchdogStorage {
  return { transaction: work => Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    const value = yield* Effect.tryPromise({ try: () => storage.transaction(tx => Effect.runPromiseWith(context)(work(cloudflareWatchdogTransaction(tx, alarms)))), catch: RuntimeError.from })
    yield* Effect.tryPromise({ try: () => storage.sync(), catch: RuntimeError.from })
    return value
  }).pipe(Effect.uninterruptible) }
}
