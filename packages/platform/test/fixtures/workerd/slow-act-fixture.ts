import { strict as assert } from "node:assert"
import { env } from "cloudflare:workers"
import { SELF, runInDurableObject } from "cloudflare:test"
import { Effect } from "effect"
import { watchdogKey } from "@clavia/tardigrade-core"
import { createMethodClient } from "@clavia/tardigrade-client"
import { cloudflareThreadName } from "../../../src/cloudflare"
import { cloudflareWatchdogStorage } from "../../../src/cloudflare/watchdog"
import { slowActor, type SlowActOptions } from "../slow-act"
import { configureSlowAct, forgetSlowAct, logSlowAct, type SlowThreadDO } from "./slow-act-fixture.worker"

export async function workerdSlowActFixture(options: SlowActOptions) {
  const instance = `watchdog-slow-${crypto.randomUUID()}`
  configureSlowAct(instance, options)
  const coordinate = { actor: "slow", instance, thread: "thread" }
  const namespace = (env as unknown as { SLOW_THREADS: DurableObjectNamespace<SlowThreadDO> }).SLOW_THREADS
  let stub = namespace.getByName(cloudflareThreadName(coordinate))
  const { methods } = await Effect.runPromise(slowActor.inspect)
  const clientOptions = { url: "http://test", instance, thread: "thread", methods, fetch: (request: Request) => SELF.fetch(request) }
  const client = createMethodClient(clientOptions)
  await Effect.runPromise(client.createThread())
  return {
    clientOptions,
    records: () => stub.records(),
    start: async () => { await Effect.runPromise(client.invoke("run", null, { id: "run" })) },
    result: async () => {
      const result = await Effect.runPromise(client.result("run", "run"))
      return result.status === "pending" ? undefined : result
    },
    log: () => Promise.resolve(logSlowAct(instance)),
    release: () => stub.release(instance),
    restart: async () => {
      try { await stub.restart() } catch (error) { assert.match(String(error), /watchdog cold restart fixture/) }
      stub = namespace.getByName(cloudflareThreadName(coordinate))
    },
    watchdog: () => runInDurableObject(stub, async (_object, state) => {
      const entries = await Effect.runPromise(cloudflareWatchdogStorage(state.storage).transaction(tx => tx.list))
      return { entry: entries.get(watchdogKey(coordinate)), alarm: await state.storage.getAlarm() }
    }),
    close: async () => { try { await stub.dispose() } finally { forgetSlowAct(instance) } },
  }
}
