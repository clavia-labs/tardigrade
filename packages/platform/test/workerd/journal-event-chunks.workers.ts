import { test, expect } from "vitest"
import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { CLOUDFLARE_SQL_LIMITS, DEFAULT_EVENT_INLINE_BYTES } from "../../src/cloudflare"
import { synchronousJournal } from "../../src/shared/synchronous-journal"
import { cloudflareNativeDriver } from "../../src/cloudflare/native-recovery"
import { storedPayloadBytes } from "../../src/shared/stored-journal-payloads"
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
        open: () => synchronousJournal({ actor: "events", driver: cloudflareNativeDriver(state.storage), limits: CLOUDFLARE_SQL_LIMITS, eventInlineBytes }),
        execute: (query) => state.storage.sql.exec(query).toArray()
      })
      const row = state.storage.sql.exec<{ payload: string | ArrayBuffer; byte_length: number | null; chunk_count: number | null; digest: string | null }>("SELECT record AS payload,byte_length,chunk_count,digest FROM stored_journal_events WHERE actor = ? AND seq = ?", "events", 3).one()
      const payload = storedPayloadBytes(row, () => state.storage.sql.exec<{ ordinal: number; payload: ArrayBuffer }>("SELECT ordinal,payload FROM stored_journal_event_chunks WHERE actor = ? AND seq = ? ORDER BY ordinal", "events", 3).toArray())
      const record: unknown = JSON.parse(new TextDecoder().decode(payload))
      expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBe((eventInlineBytes ?? DEFAULT_EVENT_INLINE_BYTES) + 1)
    }
  )
}, 120_000)
}
