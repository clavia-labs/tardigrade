import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { Effect, Schema } from "effect"
import { RuntimeError, ScheduledWake, WatchdogEntry, watchdogKey } from "@clavia/tardigrade-core"
import { makeSync, type SyncSqlite } from "@tardie/grove/sqlite"
import { makeRetryingAlarms, type CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import { initializeSyncRecovery, synchronousRecoveryStorage, type syncRecoveryTransaction } from "../shared/synchronous-recovery"

export const cloudflareNativeDriver = (storage: DurableObjectStorage): SyncSqlite => ({ identity: storage.sql, execute: (sql, parameters) => storage.sql.exec(sql, ...parameters).toArray(), transaction: work => storage.transactionSync(work) })
const checks = new WeakMap<object, Effect.Effect<void, RuntimeError>>()

// checkNativeRecovery converts KV recovery records before SQL recovery can acknowledge work (test/workerd/upgrade.workers.ts).
export function checkNativeRecovery(storage: DurableObjectStorage) {
  let check = checks.get(storage.sql)
  if (!check) {
    check = Effect.runSync(Effect.cached(Effect.tryPromise({ try: async () => {
      const wakes = await storage.list({ prefix: "tardie:scheduler:" })
      const watchdog = await storage.list({ prefix: "tardie:watchdog:" })
      const generation = await storage.get("tardie:scheduler-generation")
      if (!wakes.size && !watchdog.size && generation === undefined) return
      await storage.transaction(async tx => {
        const wakeEntries = [...await tx.list({ prefix: "tardie:scheduler:" })].map(([key, value]) => {
          const entry = Schema.decodeUnknownSync(ScheduledWake, { onExcessProperty: "error" })(value)
          if (key !== "tardie:scheduler:" + entry.id) throw new Error("Legacy scheduler identity mismatch")
          return { key, id: entry.id, entry }
        })
        const watchdogEntries = [...await tx.list({ prefix: "tardie:watchdog:" })].map(([key, value]) => {
          const entry = Schema.decodeUnknownSync(WatchdogEntry, { onExcessProperty: "error" })(value)
          if (key !== "tardie:watchdog:" + watchdogKey(entry.target)) throw new Error("Legacy watchdog identity mismatch")
          return { key, id: watchdogKey(entry.target), entry }
        })
        const rawGeneration = await tx.get("tardie:scheduler-generation")
        const savedGeneration = Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)))(rawGeneration ?? 0)
        if (wakeEntries.some(value => value.entry.generation > savedGeneration)) throw new Error("Legacy scheduler generation precedes a wake")
        const sql = storage.sql
        initializeSyncRecovery(cloudflareNativeDriver(storage))
        for (const [table, entries] of [["scheduled_wakes", wakeEntries], ["runtime_watchdogs", watchdogEntries]] as const) for (const value of entries) {
          const existing = sql.exec<{ entry: string }>(`SELECT entry FROM ${table} WHERE id=?`, value.id).toArray()[0]
          const encoded = JSON.stringify(value.entry)
          if (existing && existing.entry !== encoded) throw new Error("Conflicting legacy and native recovery records")
          if (!existing) sql.exec(`INSERT INTO ${table}(id,entry) VALUES(?,?)`, value.id, encoded)
        }
        const existingGeneration = sql.exec<{ value: number }>("SELECT value FROM scheduler_generation WHERE id=1").toArray()[0]
        if (existingGeneration && existingGeneration.value !== savedGeneration) throw new Error("Conflicting legacy and native recovery generation")
        if (!existingGeneration) sql.exec("INSERT INTO scheduler_generation(id,value) VALUES(1,?)", savedGeneration)
        await tx.delete([...wakeEntries.map(value => value.key), ...watchdogEntries.map(value => value.key), "tardie:scheduler-generation"])
      })
      await storage.sync()
    }, catch: cause => new RuntimeError("Legacy recovery data requires migration: conversion failed", { cause }) })))
    checks.set(storage.sql, check)
  }
  return check
}

// cloudflareNativeRecovery shares SQL recovery commits and alarm ordering with the journal (test/workerd/watchdog.workers.ts).
export function cloudflareNativeRecovery(storage: DurableObjectStorage, options: CloudflareAlarmOptions = {}) {
  const alarms = makeRetryingAlarms(storage, options)
  const initialized = Effect.runSync(Effect.cached(checkNativeRecovery(storage).pipe(Effect.flatMap(() => Effect.try({ try: () => {
    const driver = cloudflareNativeDriver(storage), grove = makeSync(driver, { scope: JSON.stringify(["tardigrade", "recovery"]) })
    grove.transaction(initializeSyncRecovery)
    return synchronousRecoveryStorage(grove, driver.identity, { set: at => alarms.set(Math.max(1, at)), clear: alarms.delete }, alarms.sync)
  }, catch: RuntimeError.from })))))
  return { transaction: <Value>(work: (tx: ReturnType<typeof syncRecoveryTransaction>) => Effect.Effect<Value, Error>) => initialized.pipe(Effect.flatMap(store => store.transaction(work))) }
}
