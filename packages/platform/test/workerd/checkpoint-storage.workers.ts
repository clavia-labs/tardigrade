import { test } from "vitest"
import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { cloudflareJournal, CLOUDFLARE_MAX_CHECKPOINT_CHUNK_BYTES } from "../../src/cloudflare"
import { checkpointStorage } from "../properties/checkpoint-storage"
import type { TestPromiseResolver } from "./fixture.worker"


test("checkpointStorage", async () => {
  const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  await runInDurableObject(namespace.getByName("checkpoint-storage"), async (_instance, state) => {
    await checkpointStorage({ maxChunkBytes: CLOUDFLARE_MAX_CHECKPOINT_CHUNK_BYTES, open: checkpointChunkBytes => cloudflareJournal(state.storage, "events", { checkpointChunkBytes }), execute: async query => state.storage.sql.exec(query).toArray() })
  })
})
