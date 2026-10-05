import { test, expect } from "vitest"
import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { Effect } from "effect"
import { createWatchdog, createScheduler } from "@clavia/tardigrade-core"
import { cloudflareSchedulerStorage } from "../../src/cloudflare/scheduler"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import { schedulerProperties, schedulerAcknowledgments } from "../properties/scheduler/wakes"
import type { TestPromiseResolver } from "./fixture.worker"

const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
for (const property of [schedulerProperties, schedulerAcknowledgments]) test(`workerd ${property.name}`, async () => {
  await runInDurableObject(namespace.getByName(property.name), async (_instance, state) => {
    await property({ open: options => createScheduler({ ...options, storage: cloudflareSchedulerStorage(state.storage) }), alarmAt: () => state.storage.getAlarm() })
  })
})

test("watchdog completion preserves an effect wake in the same DO", async () => {
  await runInDurableObject(namespace.getByName("scheduler-watchdog"), async (_instance, state) => {
    const storage = cloudflareWatchdogStorage(state.storage)
    const watchdog = createWatchdog({ storage, recover: () => Effect.succeed({ status: "settled", progressCursor: 1 }), invalidate: () => Effect.void })
    const scheduler = createScheduler({ storage: cloudflareSchedulerStorage(state.storage), deliver: () => watchdog.alarm })
    const dueAt = Date.now() + 60_000
    await Effect.runPromise(scheduler.schedule({ id: "effect", target: "effect", dueAt }))
    await Effect.runPromise(storage.transaction(tx => watchdog.admit(tx, { actor: "test", instance: "main" })))
    await Effect.runPromise(scheduler.alarm)
    expect(await state.storage.getAlarm()).toBe(dueAt)
    expect((await Effect.runPromise(watchdog.status)).size).toBe(0)
  })
})
