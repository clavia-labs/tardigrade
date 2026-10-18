import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { Effect } from "effect"
import { RuntimeError } from "@clavia/tardigrade-core"
import { makeSync, type SyncSqlite } from "@tardie/grove/sqlite"
import { makeRetryingAlarms, type CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import { initializeSyncRecovery, synchronousRecoveryStorage, type syncRecoveryTransaction } from "../shared/synchronous-recovery"

export const CLOUDFLARE_RECOVERY_ACTOR = "recovery"
export const cloudflareNativeDriver = (storage: DurableObjectStorage): SyncSqlite => ({ identity: storage.sql, execute: (sql, parameters) => storage.sql.exec(sql, ...parameters).toArray(), transaction: work => storage.transactionSync(work) })
const checks = new WeakMap<object, Effect.Effect<void, RuntimeError>>()

// checkNativeRecovery rejects KV recovery data before SQL recovery can acknowledge new work (test/workerd/stored-defaults.workers.ts).
export function checkNativeRecovery(storage: DurableObjectStorage) {
  let check = checks.get(storage.sql)
  if (!check) {
    check = Effect.runSync(Effect.cached(Effect.tryPromise({ try: async () => {
      for (const prefix of ["tardie:watchdog:", "tardie:scheduler:", "tardie:scheduler-generation"]) if ((await storage.list({ prefix, limit: 1 })).size) throw new Error("Legacy KV recovery data requires migration before native SQL recovery")
    }, catch: RuntimeError.from })))
    checks.set(storage.sql, check)
  }
  return check
}

// cloudflareNativeRecovery shares SQL recovery commits and alarm ordering with the journal (test/workerd/watchdog.workers.ts).
export function cloudflareNativeRecovery(storage: DurableObjectStorage, options: CloudflareAlarmOptions = {}) {
  const alarms = makeRetryingAlarms(storage, options)
  const initialized = Effect.runSync(Effect.cached(checkNativeRecovery(storage).pipe(Effect.flatMap(() => Effect.try({ try: () => {
    const driver = cloudflareNativeDriver(storage), grove = makeSync(driver, { scope: JSON.stringify(["tardigrade", CLOUDFLARE_RECOVERY_ACTOR]) })
    grove.transaction(initializeSyncRecovery)
    return synchronousRecoveryStorage(grove, driver.identity, CLOUDFLARE_RECOVERY_ACTOR, { set: at => alarms.set(Math.max(1, at)), clear: alarms.delete }, alarms.sync)
  }, catch: RuntimeError.from })))))
  return { transaction: <Value>(work: (tx: ReturnType<typeof syncRecoveryTransaction>) => Effect.Effect<Value, Error>) => initialized.pipe(Effect.flatMap(store => store.transaction(work))) }
}
