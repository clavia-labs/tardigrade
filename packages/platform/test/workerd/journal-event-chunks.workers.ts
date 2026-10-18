import { test, expect } from "vitest"
import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { cloudflareJournal, CLOUDFLARE_SQL_LIMITS, DEFAULT_EVENT_INLINE_BYTES, decodeSqlJournalRecord } from "../../src/cloudflare"
import { journalEventChunks } from "../properties/journal-event-chunks"
import type { TestPromiseResolver } from "../fixtures/workerd/fixture.worker"

for (const eventInlineBytes of [undefined, 1024]) {
test(`journalEventChunks (${eventInlineBytes ?? "default"})`, async () => {
  const namespace = (
    env as unknown as {
      PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver>
    }
  ).PROMISE_RESOLVER
  await runInDurableObject(
    namespace.getByName(`journal-event-chunks-${eventInlineBytes ?? "default"}`),
    async (_instance, state) => {
      await journalEventChunks({
        eventInlineBytes: eventInlineBytes ?? DEFAULT_EVENT_INLINE_BYTES,
        maxRowBytes: CLOUDFLARE_SQL_LIMITS.maxRowBytes,
        open: () => cloudflareJournal(state.storage, "events", { eventInlineBytes }),
        execute: (query) => state.storage.sql.exec(query).toArray()
      })
      const row = state.storage.sql.exec<{ event: string }>("SELECT event FROM experimental_events WHERE actor = ? AND seq = ?", "events", 3).one()
      const record = decodeSqlJournalRecord(row.event, () => [...state.storage.sql.exec<{ ordinal: number; payload: ArrayBuffer }>("SELECT ordinal, payload FROM experimental_event_chunks WHERE actor = ? AND seq = ? ORDER BY ordinal", "events", 3)].map(chunk => ({ ordinal: chunk.ordinal, payload: new Uint8Array(chunk.payload) })))
      expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBe((eventInlineBytes ?? DEFAULT_EVENT_INLINE_BYTES) + 1)
    }
  )
}, 120_000)
}
