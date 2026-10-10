import { env } from "cloudflare:workers"
import { SELF, runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { createWatchdog, watchdogKey } from "@clavia/tardigrade-core"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import { threadFlow } from "../fixtures/thread-flow"
import { cloudflareThreadName } from "../../src/cloudflare"
import type { LayoutActorDO, LayoutThreadDO } from "../fixtures/workerd/layout-fixture"

const bindings = env as unknown as { ACTORS: DurableObjectNamespace<InstanceType<typeof LayoutActorDO>>; THREADS: DurableObjectNamespace<LayoutThreadDO> }
const coordinate = (instance: string, thread: string) => ({ actor: "layout", instance, thread })
const threadStub = (instance: string, thread: string) => bindings.THREADS.getByName(cloudflareThreadName(coordinate(instance, thread)))
test("a fresh instance creates, queries, and messages flat independent threads with separate databases", async () => {
  const instance = "layout"
  const actor = bindings.ACTORS.getByName(instance)
  const flow = threadFlow(request => SELF.fetch(request), instance)
  await flow.run()
  expect(await actor.lookup(coordinate(instance, "parent"))).toEqual(coordinate(instance, "parent"))
  await expect.poll(async () => (await threadStub(instance, "parent").records()).find(record => record.message?.inReplyTo === "child:child")).toMatchObject({
    message: { from: coordinate(instance, "child"), inReplyTo: "child:child" },
    event: { type: "MessageReceived", body: { status: "completed", output: 73 } },
  })
  expect((await threadStub(instance, "child").records()).find(record => record.message?.id === "child:child")).toMatchObject({ message: { from: coordinate(instance, "parent") } })
  await runInDurableObject(actor, async (_object, state) => {
    const types = state.storage.sql.exec<{ event: string }>("SELECT event FROM experimental_events").toArray().map(row => JSON.parse(row.event).event.type)
    expect(types).toContain("ThreadRequested")
    expect(types).not.toContain("ThreadCreated")
  })
  for (const name of ["parent", "child"]) {
    await runInDurableObject(threadStub(instance, name), async (_object, state) => {
      const rows = state.storage.sql.exec<{ event: string }>("SELECT event FROM experimental_events ORDER BY seq").toArray()
      expect(JSON.parse(rows[0]!.event).event).toEqual({
        type: "ThreadCreated", address: coordinate(instance, name), placement: "independent",
        parent: name === "parent" ? null : coordinate(instance, "parent"), depth: name === "parent" ? 0 : 1,
      })
      expect(rows.some(row => JSON.parse(row.event).event.type === "ThreadRequested")).toBe(false)
    })
  }
})

test("a thread alarm restores checkpointed state and pending work without changing its sibling journal", async () => {
  const instance = "recovery"
  const flow = threadFlow(request => SELF.fetch(request), instance)
  for (const name of ["parent", "sibling"]) {
    expect((await flow.request("", { name, initialState: { "layout.value": 32 } })).status).toBe(200)
  }
  const parent = threadStub(instance, "parent")
  await flow.call("parent", "read", null, "initial", 32)
  expect(await parent.checkpoint()).toBeDefined()
  const sibling = await threadStub(instance, "sibling").records()
  await parent.blockSpawns(true)
  expect((await flow.request("/parent/methods/spawn", 73, "child")).status).toBe(202)
  await expect.poll(async () => (await parent.records()).some(record => record.event.type === "EffectRequested")).toBe(true)
  expect(await flow.result("parent", "spawn", "child")).toMatchObject({ status: "pending" })
  const prefix = await parent.records()
  expect(prefix.filter(record => record.event.type === "EffectRequested").every(record => record.event.type === "EffectRequested" && record.event.request.input._tag === "InputDigest")).toBe(true)
  await runInDurableObject(parent, async object => { await object.dispose() })
  await runInDurableObject(bindings.ACTORS.getByName(instance), async object => { await object.dispose() })
  await parent.blockSpawns(false)
  await parent.wake()
  await flow.completed("parent", "spawn", "child", coordinate(instance, "child"))
  await flow.completed("child", "set", "child:child", 73)
  await flow.call("parent", "read", null, "restored", 32)
  expect((await parent.records()).slice(0, prefix.length)).toEqual(prefix)
  await parent.failSpawns(true)
  expect((await flow.request("/parent/methods/spawn", 99, "retry")).status).toBe(202)
  const status = () => runInDurableObject(parent, async (_object, state) => Effect.runPromise(cloudflareWatchdogStorage(state.storage).transaction(tx => tx.list)))
  await expect.poll(async () => (await status()).get(watchdogKey(coordinate(instance, "parent")))?.status).toBe("blocked")
  const attempts = await parent.executions()
  await parent.failSpawns(false)
  await runInDurableObject(parent, async (_object, state) => {
    const watchdog = createWatchdog({ storage: cloudflareWatchdogStorage(state.storage), recover: () => Effect.die("Fixture only resumes recovery"), invalidate: () => Effect.void })
    await Effect.runPromise(watchdog.resume(coordinate(instance, "parent")))
  })
  await parent.wake()
  await flow.completed("parent", "spawn", "retry", coordinate(instance, "retry"))
  expect(await parent.executions()).toBe(attempts + 1)
  await flow.call("parent", "read", null, "after-recovery", 32)
  expect(await threadStub(instance, "sibling").records()).toEqual(sibling)
})
