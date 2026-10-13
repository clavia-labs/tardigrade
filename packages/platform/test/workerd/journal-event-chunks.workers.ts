import { test } from "vitest"
import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { cloudflareJournal, CLOUDFLARE_SQL_LIMITS } from "../../src/cloudflare"
import { journalEventChunks } from "../properties/journal-event-chunks"
import type { TestPromiseResolver } from "../fixtures/workerd/fixture.worker"

test("journalEventChunks", async () => {
  const namespace = (
    env as unknown as {
      PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver>
    }
  ).PROMISE_RESOLVER
  await runInDurableObject(
    namespace.getByName("journal-event-chunks"),
    async (_instance, state) => {
      await journalEventChunks({
        maxRowBytes: CLOUDFLARE_SQL_LIMITS.maxRowBytes,
        open: () => cloudflareJournal(state.storage, "events"),
        execute: (query) => state.storage.sql.exec(query).toArray()
      })
    }
  )
}, 120_000)
