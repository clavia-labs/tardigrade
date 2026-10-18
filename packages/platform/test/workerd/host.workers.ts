import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { cloudflareJournal } from "../../src/cloudflare"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import type { TestPromiseResolver } from "../fixtures/workerd/fixture.worker"

for (const key of ["tardie:watchdog:old", "tardie:scheduler:old", "tardie:scheduler-generation"]) test(`native defaults reject legacy recovery key ${key}`, async () => {
  const namespace = (env as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  await runInDurableObject(namespace.getByName(`legacy-recovery-${key}`), async (_object, state) => {
    await state.storage.put(key, { retained: true })
    const journal = cloudflareJournal(state.storage, "events")
    try {
      await expect(Effect.runPromise(journal.append(0, [{ event: { type: "New" } }]))).rejects.toThrow("requires migration")
      await expect(Effect.runPromise(cloudflareWatchdogStorage(state.storage).transaction(tx => tx.list))).rejects.toThrow("requires migration")
      expect(await state.storage.get(key)).toEqual({ retained: true })
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM experimental_events").one().n).toBe(0)
    } finally { await Effect.runPromise(journal.close) }
  })
})

test("native Cloudflare journal opens 0.50 events without replacing event rows", async () => {
  const namespace = (env as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  await runInDurableObject(namespace.getByName("existing-journal-default"), async (_object, state) => {
    state.storage.sql.exec("CREATE TABLE experimental_events(actor TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(actor,seq)) WITHOUT ROWID")
    const record = { event: { type: "Existing" }, recordedAt: 123 }
    state.storage.sql.exec("INSERT INTO experimental_events VALUES(?,?,?)", "events", 0, JSON.stringify(record))
    const journal = cloudflareJournal(state.storage, "events")
    try {
      expect(await Effect.runPromise(journal.read)).toEqual([record])
      await Effect.runPromise(journal.append(1, [{ event: { type: "New" } }]))
      expect(state.storage.sql.exec<{ event: string }>("SELECT event FROM experimental_events WHERE seq=0").one().event).toBe(JSON.stringify(record))
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='stored_journal_events'").toArray()).toEqual([])
    } finally { await Effect.runPromise(journal.close) }
  })
})
