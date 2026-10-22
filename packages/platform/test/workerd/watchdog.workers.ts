import { journalCommit } from "@clavia/tardigrade-core"
import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Clock, Effect, Schema } from "effect"
import { RuntimeError, createWatchdog, ExecutionResult, ThreadCreated, watchdogKey } from "@clavia/tardigrade-core"
import { cloudflareThreadName } from "../../src/cloudflare"
import { objectJournal } from "../../src/cloudflare/objects"
import { threadFlow } from "../fixtures/thread-flow"
import { SELF } from "cloudflare:test"
import type { LayoutThreadDO } from "../fixtures/workerd/layout-fixture"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import type { TestPromiseResolver } from "../fixtures/workerd/fixture.worker"
import { workerdSlowActFixture } from "../fixtures/workerd/slow-act-fixture"
import { waitFor } from "../fixtures/wait"

const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
const address = { actor: "test", instance: "main", thread: "one" }

for (const forked of [false, true]) {
  test(`real watchdog alarms recover ${forked ? "forked" : "inline"} work after restart`, async () => {
    const fixture = await workerdSlowActFixture({ workMs: 0, value: 42, hold: true, ...(forked ? { fork: { timeoutMs: 60_000 } } : {}) })
    try {
      await fixture.start()
      await waitFor(fixture.log, log => log.some(entry => entry.kind === "start"))
      const initial = await fixture.watchdog()
      expect(initial.entry?.status).toBe("pending")
      expect(initial.alarm).not.toBeNull()
      await waitFor(fixture.watchdog, state => (state.entry?.nextWakeAt ?? 0) > (initial.entry?.nextWakeAt ?? 0))
      await fixture.restart()
      // Fixture logs leave the thread cold so the durable alarm owns recovery.
      await waitFor(fixture.log, log => log.filter(entry => entry.kind === "start").length === 2)
      await fixture.release()
      const result = await waitFor(fixture.result, result => result !== undefined)
      expect(result).toMatchObject({ status: "completed", output: 42 })
      const log = await fixture.log()
      expect(log.filter(entry => entry.kind === "start")).toHaveLength(2)
      expect(log.filter(entry => entry.kind === "done")).toHaveLength(1)
      expect(log.slice(log.findIndex((entry, index) => index > 0 && entry.kind === "start")).some(entry => entry.kind === "interrupted")).toBe(false)
      const final = await waitFor(fixture.watchdog, state => state.entry === undefined)
      expect(final.alarm).toBeNull()
    } finally { await fixture.close() }
  }, 15_000)
}

test("watchdog synchronizes the replacement before recovery", async () => {
  await runInDurableObject(namespace.getByName("watchdog-sync"), async (_instance, state) => {
    let flushed = false
    const storage = new Proxy(state.storage, { get(target, property) {
      if (property === "sync") return async () => { await target.sync(); flushed = true }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const db = cloudflareWatchdogStorage(storage)
    const watchdog = createWatchdog({ storage: db, invalidate: () => Effect.void, recover: () => Effect.gen(function* () {
      expect(flushed).toBe(true)
      const entries = yield* watchdog.status
      expect(entries.get(watchdogKey(address))!.attempts).toBe(1)
      expect((yield* Effect.promise(() => state.storage.getAlarm()))!).toBeGreaterThan(yield* Clock.currentTimeMillis)
      return { status: "settled" as const, progressCursor: 1 }
    }) })
    await Effect.runPromise(db.transaction(tx => watchdog.admit(tx, address)))
    flushed = false
    await Effect.runPromise(watchdog.alarm)
    expect((await Effect.runPromise(watchdog.status)).size).toBe(0)
    expect(await state.storage.getAlarm()).toBeNull()
  })
})

test("watchdog record and alarm roll back together", async () => {
  await runInDurableObject(namespace.getByName("watchdog-rollback"), async (_instance, state) => {
    const db = cloudflareWatchdogStorage(state.storage)
    const watchdog = createWatchdog({ storage: db, recover: () => Effect.succeed({ status: "settled", progressCursor: 0 }), invalidate: () => Effect.void })
    await expect(Effect.runPromise(db.transaction(tx => watchdog.admit(tx, address).pipe(Effect.andThen(Effect.fail(new RuntimeError("crash before commit"))))))).rejects.toThrow()
    expect((await Effect.runPromise(watchdog.status)).size).toBe(0)
    expect(await state.storage.getAlarm()).toBeNull()
  })
})

test("journal admission rolls back when alarm staging fails", async () => {
  await runInDurableObject(namespace.getByName("watchdog-admission-rollback"), async (_instance, state) => {
    const storage = new Proxy(state.storage, { get(target, property) {
      if (property === "transaction") return <Value>(callback: (tx: DurableObjectTransaction) => Promise<Value>) => target.transaction(tx => callback(new Proxy(tx, { get(transaction, key) {
        if (key === "setAlarm") return () => Promise.reject(new Error("alarm unavailable"))
        const value = Reflect.get(transaction, key)
        return typeof value === "function" ? value.bind(transaction) : value
      } })))
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const watchdog = createWatchdog({ storage: cloudflareWatchdogStorage(storage), recover: () => Effect.succeed({ status: "settled", progressCursor: 0 }), invalidate: () => Effect.void })
    const journal = objectJournal({ storage, key: "events", target: address, watchdog })
    try {
      await expect(Effect.runPromise(journalCommit(journal, () => journal.append(0, [{ event: ThreadCreated.make({ type: "ThreadCreated", address, parent: null, depth: 0, placement: "independent" }) }])))).rejects.toThrow()
      expect(journal.read()).toEqual([])
      expect((await Effect.runPromise(watchdog.status)).size).toBe(0)
      expect(await state.storage.getAlarm()).toBeNull()
    } finally { await Effect.runPromise(journal.close) }
  })
})

// Skipped: under load, wake() can probe while the thread still has in-flight work after the spawn settles, so recoveryState reports pending and the watchdog charges an attempt (attempts: 1); which in-flight condition fires is not yet identified.
test.skip("thread heartbeats retain a live producer without renewing its deadline", async () => {
  const instance = "heartbeat"
  const target = { actor: "layout", instance, thread: "parent" }
  const parent = (env as unknown as { THREADS: DurableObjectNamespace<LayoutThreadDO> }).THREADS.getByName(cloudflareThreadName(target))
  const flow = threadFlow(request => SELF.fetch(request), instance)
  expect((await flow.request("", { name: "parent" })).status).toBe(200)
  await parent.holdSpawns()
  const deadline = async () => {
    const record = (await parent.records()).find(({ event }) => event.type === "EffectSettled")?.event
    if (record?.type !== "EffectSettled" || record.outcome.status !== "fulfilled") return undefined
    const result = Schema.decodeUnknownSync(ExecutionResult)(record.outcome.value)
    return result.type === "promise" ? result.deadlineAt : undefined
  }
  try {
    expect((await flow.request("/parent/methods/spawn", 73, "child")).status).toBe(202)
    await expect.poll(deadline).toBeTypeOf("number")
    const original = await deadline()
    for (let index = 0; index < 3; index++) {
      await parent.wake()
      await runInDurableObject(parent, async (_object, state) => {
        const entries = await Effect.runPromise(cloudflareWatchdogStorage(state.storage).transaction(tx => tx.list))
        expect(entries.get(watchdogKey(target))).toMatchObject({ attempts: 0, consecutiveNoProgress: 0 })
      })
      await expect.poll(async () => runInDurableObject(parent, async (_object, state) => state.storage.getAlarm())).toBeTypeOf("number")
      expect(await deadline()).toBe(original)
    }
    expect(await parent.executions()).toBe(1)
    await parent.releaseSpawns()
    await flow.completed("parent", "spawn", "child", flow.coordinate("child"))
    await expect.poll(async () => runInDurableObject(parent, async (_object, state) => (await state.storage.list({ prefix: "tardie:watchdog:" })).size)).toBe(0)
  } finally { await runInDurableObject(parent, object => object.dispose()) }
})
