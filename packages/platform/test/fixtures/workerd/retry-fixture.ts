import { strict as assert } from "node:assert"
import { env } from "cloudflare:workers"
import { SELF, runInDurableObject } from "cloudflare:test"
import { Effect, Schema } from "effect"
import { methodResult, watchdogKey } from "@clavia/tardigrade-core"
import { cloudflareThreadName } from "../../../src/cloudflare"
import { cloudflareWatchdogStorage } from "../../../src/cloudflare/watchdog"
import type { RetryServiceOptions } from "../retry-actor"
import type { RetryFixture } from "../../properties/retries/lifecycle"
import { configureRetry, type RetryThreadDO } from "./retry-fixture.worker"

export async function workerdRetryFixture(options: RetryServiceOptions): Promise<RetryFixture> {
  const instance = `retry-direct-${crypto.randomUUID()}`
  configureRetry(instance, options)
  const coordinate = { actor: "direct-retry", instance, thread: "thread" }
  const namespace = (env as unknown as { RETRY_THREADS: DurableObjectNamespace<RetryThreadDO> }).RETRY_THREADS
  const stub = namespace.getByName(cloudflareThreadName(coordinate))
  const base = `http://test/v1/actors/${instance}/threads`
  assert.equal((await SELF.fetch(base, { method: "POST", body: JSON.stringify({ name: "thread" }) })).status, 200)
  const method = `${base}/thread/methods/run`
  const start = async () => { assert.equal((await SELF.fetch(method, { method: "POST", headers: { "idempotency-key": "run" }, body: "null" })).status, 202) }
  const resultSchema = Schema.Union([methodResult(Schema.Finite), Schema.Struct({ status: Schema.Literal("pending") })])
  return {
    start,
    result: async () => {
      const result = Schema.decodeUnknownSync(resultSchema)(await (await SELF.fetch(`${method}/calls/run`)).json())
      return result.status === "pending" ? undefined : result
    },
    records: () => stub.records(),
    restart: async () => { await stub.dispose(); await start() },
    cancel: ref => stub.cancelEffect(instance, ref),
    stats: () => stub.stats(instance),
    recoveryWake: () => runInDurableObject(stub, async (_object, state) => {
      const entries = await Effect.runPromise(cloudflareWatchdogStorage(state.storage).transaction(tx => tx.list))
      return entries.get(watchdogKey(coordinate))?.nextWakeAt ?? undefined
    }),
    close: () => stub.dispose(),
  }
}
