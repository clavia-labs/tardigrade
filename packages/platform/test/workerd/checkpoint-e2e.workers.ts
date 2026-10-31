import { strict as assert } from "node:assert"
import { env } from "cloudflare:workers"
import { SELF } from "cloudflare:test"
import { test } from "vitest"
import { decodeCheckpoint } from "@clavia/tardigrade-core"
import { cloudflareThreadName } from "../../src/cloudflare"
import { checkpointE2E } from "../properties/checkpoint/e2e"
import { atomPopulationKinds } from "../fixtures/atoms/population"
import { CHECKPOINT_E2E_ACTOR, checkpointE2EInstance } from "../fixtures/atoms/checkpoint-actor"
import { RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"
import type { RegularCheckpointThreadDO, FamilyCheckpointThreadDO, MixedCheckpointThreadDO } from "../fixtures/workerd/checkpoint-e2e.worker"

const bindings = env as unknown as {
  CHECKPOINT_REGULAR_THREADS: DurableObjectNamespace<RegularCheckpointThreadDO>
  CHECKPOINT_FAMILY_THREADS: DurableObjectNamespace<FamilyCheckpointThreadDO>
  CHECKPOINT_MIXED_THREADS: DurableObjectNamespace<MixedCheckpointThreadDO>
}
const namespaces = { regular: bindings.CHECKPOINT_REGULAR_THREADS, family: bindings.CHECKPOINT_FAMILY_THREADS, mixed: bindings.CHECKPOINT_MIXED_THREADS }
for (const kind of atomPopulationKinds) test(`checkpoint E2E survives native abort (${kind})`, async () => {
  const namespace = namespaces[kind]
  const name = cloudflareThreadName({ actor: CHECKPOINT_E2E_ACTOR, instance: checkpointE2EInstance(kind), thread: "one" })
  let stub = namespace.getByName(name)
  try {
    await checkpointE2E(kind, {
      fetch: request => SELF.fetch(request),
      checkpoint: async () => { const saved = await stub.checkpoint(); return saved ? decodeCheckpoint(saved.payload) : undefined },
      restart: async () => {
        let aborted = false
        try { await stub.abort() }
        catch (error) { assert.match(String(error), /Checkpoint E2E reset/); aborted = true }
        assert.ok(aborted)
        stub = namespace.getByName(name)
      },
    })
  } finally { await stub.dispose() }
}, RUNTIME_PROPERTY_TEST_TIMEOUT_MS)
