import { env } from "cloudflare:workers"
import { SELF, runInDurableObject } from "cloudflare:test"
import { expect, inject, test } from "vitest"
import { Effect } from "effect"
import { createWatchdog, watchdogKey, DEFAULT_PROVISION_RETRY_LIMIT, journalCommit, type SupervisorEvent } from "@clavia/tardigrade-core"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import { RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"
import { threadFlow } from "../fixtures/thread-flow"
import { cloudflareThreadName, cloudflareJournal } from "../../src/cloudflare"
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
  await expect.poll(async () => (await status()).get(watchdogKey(coordinate(instance, "parent")))?.status).toBe("blocked")
  expect(await flow.result("parent", "spawn", "retry")).toMatchObject({ status: "failed", error: expect.stringContaining("injected spawn defect") })
  expect(await parent.executions()).toBe(attempts)
  expect((await parent.records()).filter(record => record.event.type === "EffectDied")).toHaveLength(1)
  await flow.completed("parent", "read", "restored", 32)
  expect(await threadStub(instance, "sibling").records()).toEqual(sibling)
})


test("directory admission and a turn survive retryable provisioning and lookup resets", async () => {
  const instance = "rpc-reset"
  const actor = bindings.ACTORS.getByName(instance)
  const flow = threadFlow(request => SELF.fetch(request), instance)
  await actor.resetNextProvision("parent")
  expect((await flow.request("", { name: "parent", initialState: { "layout.value": 32 } })).status).toBe(200)
  await actor.resetNextLookup()
  expect((await threadStub(instance, "parent").fetch(new Request(`https://layout.test/v1/actors/${instance}/threads/parent/methods/set`, {
    method: "POST", headers: { "idempotency-key": "same-call", "content-type": "application/json" }, body: "73",
  }))).status).toBe(202)
  await flow.completed("parent", "set", "same-call", 73)
  await flow.call("parent", "set", 73, "same-call", 73)
  await flow.call("parent", "read", null, "read", 73)
  const records = await threadStub(instance, "parent").records()
  expect(records.filter(record => record.event.type === "ThreadCreated")).toHaveLength(1)
  expect(records.filter(record => record.message?.id === "same-call")).toHaveLength(1)
  await runInDurableObject(actor, async (_object, state) => {
    const events = state.storage.sql.exec<{ event: string }>("SELECT event FROM experimental_events").toArray().map(row => JSON.parse(row.event).event.type)
    expect(events.filter(type => type === "ThreadRegistered")).toHaveLength(1)
    expect(events).not.toContain("ThreadFailed")
  })
})

test("provisioning retries survive reopening and concurrent named requests share one thread", async () => {
  const instance = "parallel-reopen"
  const actor = bindings.ACTORS.getByName(instance)
  const flow = threadFlow(request => SELF.fetch(request), instance, { policy: { timeoutMs: 20_000 } })
  const held = threadStub(instance, "held")
  await held.holdProvision()
  await held.failNextProvisions(1)
  const original = flow.request("", { name: "held", initialState: { "layout.value": 32 } }).catch(() => undefined)
  try {
    await expect.poll(() => held.provisionCalls()).toBe(2)
    await runInDurableObject(actor, async object => { await object.dispose() })
    expect((await flow.request("", { name: "unrelated" })).status).toBe(200)
    expect(await actor.lookup(coordinate(instance, "held"))).toBeUndefined()
    const pending = Promise.all(Array.from({ length: 5 }, () => flow.request("", { name: "held", initialState: { "layout.value": 32 } })))
    expect((await flow.request("", { name: "held", initialState: { "layout.value": 99 } })).status).toBeGreaterThanOrEqual(400)
    await held.releaseProvision()
    for (const response of await pending) {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(coordinate(instance, "held"))
    }
    expect((await held.records()).filter(record => record.event.type === "ThreadCreated")).toHaveLength(1)
    await flow.call("held", "read", null, "read-reopened", 32)
    const failed = threadStub(instance, "failed")
    for (const round of [1, 2]) {
      await failed.failNextProvisions(DEFAULT_PROVISION_RETRY_LIMIT + 1)
      expect((await flow.request("", { name: "failed", initialState: { "layout.value": 44 } })).status).toBeGreaterThanOrEqual(400)
      expect(await failed.provisionCalls()).toBe(round * (DEFAULT_PROVISION_RETRY_LIMIT + 1))
    }
    expect((await flow.request("", { name: "failed", initialState: { "layout.value": 99 } })).status).toBeGreaterThanOrEqual(400)
    await runInDurableObject(actor, async (object, state) => {
      await object.dispose()
      state.storage.sql.exec("DELETE FROM checkpoint_chunks")
      state.storage.sql.exec("DELETE FROM checkpoint")
    })
    await failed.failNextProvisions(1)
    const retried = await Promise.all(Array.from({ length: 5 }, () => flow.request("", { name: "failed" })))
    for (const response of retried) {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(coordinate(instance, "failed"))
    }
    expect((await failed.records()).filter(record => record.event.type === "ThreadCreated")).toHaveLength(1)
    await flow.call("failed", "read", null, "read-retried", 44)
    expect((await flow.request("", { name: "failed" })).status).toBe(200)
    expect(await failed.provisionCalls()).toBe(2 * (DEFAULT_PROVISION_RETRY_LIMIT + 1) + 2)
    await runInDurableObject(actor, async (_object, state) => {
      const events = state.storage.sql.exec<{ event: string }>("SELECT event FROM experimental_events ORDER BY seq").toArray().map(row => JSON.parse(row.event).event)
      const requests = events.filter(event => event.type === "ThreadRequested" && event.allocation.coordinate.thread === "failed")
      expect(events.filter(event => event.type === "RetryScheduled")).toHaveLength(2 * DEFAULT_PROVISION_RETRY_LIMIT + 2)
      expect(events.filter(event => event.type === "EffectRequested")).toHaveLength(5)
      expect(events.filter(event => event.type === "ThreadFailed")).toHaveLength(2)
      expect(requests).toHaveLength(3)
      for (const request of requests) expect(request.allocation).toEqual(requests[0].allocation)
    })
    expect((await flow.request("", { name: "after-failure" })).status).toBe(200)
  } finally { await held.releaseProvision(); await original }
}, RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

test("legacy late registrations re-verify existing threads without rewriting the journal prefix", async () => {
  const instance = "legacy-late-registration"
  const actor = bindings.ACTORS.getByName(instance)
  const flow = threadFlow(request => SELF.fetch(request), instance)
  expect((await flow.request("", { name: "bootstrap" })).status).toBe(200)
  const address = coordinate(instance, "late")
  const child = threadStub(instance, "late")
  await child.provision({ type: "ThreadCreated", address, parent: null, depth: 0, placement: "independent" }, { "layout.value": 32 })
  const prefix = await runInDurableObject(actor, async (object, state) => {
    await object.dispose()
    const journal = cloudflareJournal<SupervisorEvent>(state.storage, JSON.stringify(["layout", instance, "supervisor"]))
    try {
      await Effect.runPromise(journalCommit(journal, () => journal.append(journal.readPosition(), [
        { event: { type: "ThreadRequested", allocation: { coordinate: address, name: "late", parent: null, depth: 0, placement: "independent", initialState: { "layout.value": 32 } } } },
        { event: { type: "ThreadFailed", coordinate: address, reason: "legacy timeout" } },
        { event: { type: "ThreadRegistered", coordinate: address } },
      ])))
      state.storage.sql.exec("UPDATE checkpoint SET tag = ?", "host.supervisor.families/1")
      return state.storage.sql.exec<{ event: string }>("SELECT event FROM experimental_events ORDER BY seq").toArray().map(row => row.event)
    } finally { await Effect.runPromise(journal.close) }
  })
  expect((await flow.request("", { name: "late" })).status).toBe(200)
  expect(await actor.lookup(address)).toEqual(address)
  expect(await child.provisionCalls()).toBe(2)
  expect((await child.records()).filter(record => record.event.type === "ThreadCreated")).toHaveLength(1)
  await flow.call("late", "read", null, "legacy-seed", 32)
  await runInDurableObject(actor, async (object, state) => {
    const rows = state.storage.sql.exec<{ event: string }>("SELECT event FROM experimental_events ORDER BY seq").toArray().map(row => row.event)
    expect(rows.slice(0, prefix.length)).toEqual(prefix)
    expect(rows.slice(prefix.length).map(row => JSON.parse(row).event).filter(event => event.type === "ThreadRegistered")).toEqual([{ type: "ThreadRegistered", coordinate: address }])
    await object.dispose()
  })
  expect(await actor.lookup(address)).toEqual(address)
  expect(await child.provisionCalls()).toBe(2)
})

test.skipIf(!inject("longTests"))("200 concurrent creates finish while another thread is still provisioning", async () => {
  const instance = "parallel-creates"
  const actor = bindings.ACTORS.getByName(instance)
  const flow = threadFlow(request => SELF.fetch(request), instance, { policy: { timeoutMs: 30_000 } })
  const held = threadStub(instance, "held")
  await held.holdProvision()
  const blocked = flow.request("", { name: "held" })
  await expect.poll(() => held.provisioning()).toBe(true)
  const started = Date.now()
  try {
    const elapsed = await Promise.all(Array.from({ length: 200 }, async (_, index) => {
      const name = `thread-${index}`
      const response = await flow.request("", { name, initialState: { "layout.value": index } })
      expect(response.status).toBe(200)
      expect(await actor.lookup(coordinate(instance, name))).toEqual(coordinate(instance, name))
      return Date.now() - started
    }))
    elapsed.sort((a, b) => a - b)
    console.log(JSON.stringify({ creates: elapsed.length, p50Ms: elapsed[100], p95Ms: elapsed[190], maxMs: elapsed[199] }))
    expect(elapsed[199]).toBeLessThan(20_000)
    expect(await actor.lookup(coordinate(instance, "held"))).toBeUndefined()
    await flow.call("thread-199", "read", null, "read-parallel", 199)
  } finally {
    await held.releaseProvision()
    expect((await blocked).status).toBe(200)
  }
}, 30_000)
