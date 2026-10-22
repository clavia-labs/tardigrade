import { env } from "cloudflare:workers"
import { SELF, runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import * as fc from "fast-check"
import { Effect, Schema } from "effect"
import { ExecutionResult, watchdogKey } from "@clavia/tardigrade-core"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import { cloudflareThreadName } from "../../src/cloudflare"
import { threadFlow } from "../fixtures/thread-flow"
import type { LayoutActorDO, LayoutThreadDO } from "../fixtures/workerd/layout-fixture"

const bindings = env as unknown as { ACTORS: DurableObjectNamespace<InstanceType<typeof LayoutActorDO>>; THREADS: DurableObjectNamespace<LayoutThreadDO> }
const coordinate = (instance: string, thread: string) => ({ actor: "layout", instance, thread })
const threadStub = (instance: string, thread: string) => bindings.THREADS.getByName(cloudflareThreadName(coordinate(instance, thread)))
let instances = 0

test("recovery: a spawn defect blocks the watchdog", async () => {
  await fc.assert(fc.asyncProperty(fc.record({ held: fc.boolean(), restart: fc.boolean() }), async ({ held, restart }) => {
    const instance = `defect-${instances++}`
    const flow = threadFlow(request => SELF.fetch(request), instance)
    const parent = threadStub(instance, "parent")
    expect((await flow.request("", { name: "parent", initialState: { "layout.value": 32 } })).status).toBe(200)
    await flow.call("parent", "read", null, "initial", 32)
    if (held) {
      await parent.holdSpawns()
      expect((await flow.request("/parent/methods/spawn", 1, "held")).status).toBe(202)
      await expect.poll(async () => (await parent.records()).some(({ event }) => event.type === "EffectSettled" && event.outcome.status === "fulfilled" && Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value).type === "promise")).toBe(true)
    }
    if (restart) {
      await runInDurableObject(parent, async object => { await object.dispose() })
      await runInDurableObject(bindings.ACTORS.getByName(instance), async object => { await object.dispose() })
    }
    await parent.failSpawns(true)
    try {
      expect((await flow.request("/parent/methods/spawn", 99, "retry")).status).toBe(202)
      const status = () => runInDurableObject(parent, async (_object, state) => Effect.runPromise(cloudflareWatchdogStorage(state.storage).transaction(tx => tx.list)))
      await expect.poll(async () => (await status()).get(watchdogKey(coordinate(instance, "parent")))?.status, { timeout: 5_000 }).toBe("blocked")
      expect((await status()).get(watchdogKey(coordinate(instance, "parent")))?.reason).toContain("injected spawn defect")
    } finally {
      await parent.failSpawns(false)
      if (held) await parent.releaseSpawns()
    }
  }), { numRuns: 8, examples: [[{ held: false, restart: false }], [{ held: true, restart: false }]] })
}, 120_000)
