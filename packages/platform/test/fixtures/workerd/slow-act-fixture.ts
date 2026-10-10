import { strict as assert } from "node:assert"
import { env } from "cloudflare:workers"
import { SELF, runInDurableObject } from "cloudflare:test"
import { Effect, Schema } from "effect"
import { methodResult, watchdogKey } from "@clavia/tardigrade-core"
import { cloudflareThreadName } from "../../../src/cloudflare"
import { cloudflareWatchdogStorage } from "../../../src/cloudflare/watchdog"
import type { SlowActOptions } from "../slow-act"
import type { LiveInlineFixture } from "../../properties/watchdog/live-inline"
import { configureSlowAct, forgetSlowAct, logSlowAct, type SlowThreadDO } from "./slow-act-fixture.worker"

export async function workerdSlowActFixture(options: SlowActOptions): Promise<LiveInlineFixture> {
  const instance = `watchdog-slow-${crypto.randomUUID()}`
  configureSlowAct(instance, options)
  const coordinate = { actor: "slow", instance, thread: "thread" }
  const namespace = (env as unknown as { SLOW_THREADS: DurableObjectNamespace<SlowThreadDO> }).SLOW_THREADS
  let stub = namespace.getByName(cloudflareThreadName(coordinate))
  const base = `http://test/v1/actors/${instance}/threads`
  assert.equal((await SELF.fetch(base, { method: "POST", body: JSON.stringify({ name: "thread" }) })).status, 200)
  const method = `${base}/thread/methods/run`
  const resultSchema = Schema.Union([methodResult(Schema.Finite), Schema.Struct({ status: Schema.Literal("pending") })])
  return {
    start: async () => { assert.equal((await SELF.fetch(method, { method: "POST", headers: { "idempotency-key": "run" }, body: "null" })).status, 202) },
    result: async () => {
      const result = Schema.decodeUnknownSync(resultSchema)(await (await SELF.fetch(`${method}/calls/run`)).json())
      return result.status === "pending" ? undefined : result
    },
    log: () => Promise.resolve(logSlowAct(instance)),
    crash: async () => {
      try { await stub.crash() } catch (error) { assert.match(String(error), /watchdog cold recovery property/) }
      stub = namespace.getByName(cloudflareThreadName(coordinate))
    },
    watchdog: () => runInDurableObject(stub, async (_object, state) => {
      const entries = await Effect.runPromise(cloudflareWatchdogStorage(state.storage).transaction(tx => tx.list))
      return { entry: entries.get(watchdogKey(coordinate)), alarm: await state.storage.getAlarm() }
    }),
    close: async () => { try { await stub.dispose() } finally { forgetSlowAct(instance) } },
  }
}
