import fc from "fast-check"
import fixture from "../fixtures/migration/050-snapshot.json"
import { env } from "cloudflare:workers"
import { runInDurableObject, evictDurableObject } from "cloudflare:test"
import { test, expect } from "vitest"
import { type TestPromiseResolver } from "../fixtures/workerd/fixture.worker"
import { Effect } from "effect"
import { cloudflareJournal } from "../../src/cloudflare"
import { cloudflareNativeRecovery } from "../../src/cloudflare/native-recovery"
import { migrationProperties } from "../properties/integration"
import { withSqlite } from "../fixtures/workerd/sqlite"

const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER

test("recovery transfer rolls back partial SQL writes before clearing KV and retries after eviction", () => fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async generation => {
  const stub = namespace.getByName(crypto.randomUUID())
  const expected = await runInDurableObject(stub, async (_instance, state) => {
    const wake = { ...fixture.recovery.wake, generation }
    const entries = { ["tardie:scheduler:" + wake.id]: wake, ["tardie:watchdog:" + fixture.recovery.key]: fixture.recovery.watchdog, "tardie:scheduler-generation": generation }
    await state.storage.put(entries)
    await state.storage.setAlarm(fixture.recovery.dueAt)
    state.storage.sql.exec("CREATE TABLE stored_watchdog_entries(actor TEXT NOT NULL,id TEXT NOT NULL,entry TEXT NOT NULL,PRIMARY KEY(actor,id)) WITHOUT ROWID")
    state.storage.sql.exec("CREATE TRIGGER recovery_migration_fault BEFORE INSERT ON stored_watchdog_entries BEGIN SELECT RAISE(ABORT,'recovery migration fault'); END")
    const journal = cloudflareJournal(state.storage, "events")
    try {
      await expect(Effect.runPromise(journal.readVersion)).rejects.toThrow("requires migration")
      expect(Object.fromEntries(await state.storage.list({ prefix: "tardie:" }))).toEqual(entries)
      expect(await state.storage.getAlarm()).toBe(fixture.recovery.dueAt)
      for (const table of ["stored_scheduler_wakes", "stored_watchdog_entries", "stored_scheduler_generation"]) {
        if (state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name=?", table).toArray().length) expect(state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`).one().n).toBe(0)
      }
      state.storage.sql.exec("DROP TRIGGER recovery_migration_fault")
      return entries
    } finally { await Effect.runPromise(journal.close) }
  })
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (_instance, state) => {
    const journal = cloudflareJournal(state.storage, "events")
    try {
      await Effect.runPromise(journal.readVersion)
      expect(await state.storage.list({ prefix: "tardie:" })).toEqual(new Map())
      expect(await state.storage.getAlarm()).toBe(fixture.recovery.dueAt)
      expect(JSON.parse(state.storage.sql.exec<{ entry: string }>("SELECT entry FROM stored_scheduler_wakes").one().entry)).toEqual(expected["tardie:scheduler:" + fixture.recovery.wake.id])
      expect(JSON.parse(state.storage.sql.exec<{ entry: string }>("SELECT entry FROM stored_watchdog_entries").one().entry)).toEqual(fixture.recovery.watchdog)
      const recovery = cloudflareNativeRecovery(state.storage)
      expect(await Effect.runPromise(recovery.transaction(tx => tx.scheduler.allocateGeneration))).toBe(generation + 1)
    } finally { await Effect.runPromise(journal.close) }
  })
}), { numRuns: 5, includeErrorInReport: true }), 30000)

for (const property of migrationProperties) test(property.name, () => property.run(withSqlite, property.workerRuns), 30_000)
