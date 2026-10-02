import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Clock, Effect } from "effect"
import { createCloudflarePromiseResolver } from "../../src/cloudflare/promise-resolver"
import { RuntimeError, type ResolutionSettled } from "@clavia/tardigrade-core"

import type { TestPromiseResolver } from "./fixture.worker"

const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
const request = { recipient: { actor: "test", instance: "main", thread: "one" }, ref: { atom: "a", seq: 1, tag: "job" }, handle: { executor: "remote", id: "job", mode: "push" as const } }

async function controlledClock() {
  const base = await Effect.runPromise(Clock.Clock)
  let now = Date.now() + 60_000
  const clock: Clock.Clock = { ...base, currentTimeMillisUnsafe: () => now, currentTimeMillis: Effect.sync(() => now) }
  return {
    run: <Value, Failure>(work: Effect.Effect<Value, Failure>) => Effect.runPromise(work.pipe(Effect.provideService(Clock.Clock, clock))),
    advance: (ms: number) => { now += ms },
    now: () => now,
  }
}

test("Promise resolver persists push deadlines across resolver reopening and ignores late completion", async () => {
  const stub = namespace.getByName("deadline")
  await runInDurableObject(stub, async (_instance, state) => {
    const time = await controlledClock()
    const delivered: ResolutionSettled[] = []
    const make = (timeoutMs: number) => createCloudflarePromiseResolver({ storage: state.storage, policy: { timeoutMs }, deliver: (_recipient, settlement) => Effect.sync(() => { delivered.push(settlement) }) })
    const original = make(30)
    await time.run(original.watch(request))
    const deadline = await state.storage.getAlarm()
    expect(deadline).not.toBeNull()
    const reopened = make(100_000)
    await time.run(reopened.watch(request))
    expect(await state.storage.getAlarm()).toBe(deadline)
    time.advance(40)
    await time.run(reopened.alarm)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.result).toEqual({ status: "rejected", reason: { _tag: "PromiseTimedOut", deadlineAt: deadline } })
    await time.run(reopened.accept({ handle: request.handle, result: { status: "fulfilled", value: "late" } }))
    await time.run(reopened.alarm)
    expect(delivered).toHaveLength(1)
  })
})

test("Promise resolver retries timeout delivery without spinning an expired alarm", async () => {
  const stub = namespace.getByName("delivery")
  await runInDurableObject(stub, async (_instance, state) => {
    const time = await controlledClock()
    let attempts = 0
    const resolver = createCloudflarePromiseResolver({ storage: state.storage, policy: { timeoutMs: 20, retryIntervalMs: 15 }, deliver: () => Effect.suspend(() => ++attempts === 1 ? Effect.fail(new RuntimeError("offline")) : Effect.void) })
    await time.run(resolver.watch(request))
    time.advance(30)
    await time.run(resolver.alarm)
    expect(attempts).toBe(1)
    expect((await state.storage.getAlarm())!).toBeGreaterThan(time.now())
    time.advance(20)
    await time.run(resolver.alarm)
    expect(attempts).toBe(2)
  })
})

test("Promise resolver chooses early completion and observes push notifications by polling", async () => {
  const stub = namespace.getByName("completion")
  await runInDurableObject(stub, async (_instance, state) => {
    const time = await controlledClock()
    const delivered: ResolutionSettled[] = []
    let polls = 0
    const resolver = createCloudflarePromiseResolver({ storage: state.storage, policy: { timeoutMs: 100 }, poll: () => Effect.sync(() => { polls++; return { status: "fulfilled" as const, value: "notified" } }), deliver: (_recipient, settlement) => Effect.sync(() => { delivered.push(settlement) }) })
    await time.run(resolver.accept({ handle: request.handle, result: { status: "fulfilled", value: "early" } }))
    await time.run(resolver.watch(request))
    await time.run(resolver.alarm)
    expect(delivered[0]!.result).toEqual({ status: "fulfilled", value: "early" })
    const other = { ...request, ref: { ...request.ref, tag: "two" }, handle: { ...request.handle, id: "two" } }
    await time.run(resolver.watch(other))
    await time.run(resolver.accept({ id: "notification", handle: other.handle }))
    await time.run(resolver.alarm)
    expect(polls).toBe(1)
    expect(delivered[1]!.result).toEqual({ status: "fulfilled", value: "notified" })
  })
})

test("Promise resolver rejects a buffered completion received after its deadline", async () => {
  const stub = namespace.getByName("buffered-late")
  await runInDurableObject(stub, async (_instance, state) => {
    const delivered: ResolutionSettled[] = []
    const resolver = createCloudflarePromiseResolver({ storage: state.storage, deliver: (_recipient, settlement) => Effect.sync(() => { delivered.push(settlement) }) })
    const deadlineAt = Date.now() - 1_000
    await Effect.runPromise(resolver.accept({ handle: request.handle, result: { status: "fulfilled", value: "late" } }))
    await Effect.runPromise(resolver.watch({ ...request, deadlineAt }))
    await Effect.runPromise(resolver.alarm)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.result).toEqual({ status: "rejected", reason: { _tag: "PromiseTimedOut", deadlineAt } })
  })
})

test("Promise resolver preserves timely buffered completion across late duplicate and reopening", async () => {
  const stub = namespace.getByName("buffered-timely")
  await runInDurableObject(stub, async (_instance, state) => {
    const delivered: ResolutionSettled[] = []
    const make = () => createCloudflarePromiseResolver({ storage: state.storage, deliver: (_recipient, settlement) => Effect.sync(() => { delivered.push(settlement) }) })
    const resolver = make()
    const completion = { handle: request.handle, result: { status: "fulfilled" as const, value: "early" } }
    await Effect.runPromise(resolver.accept(completion))
    const buffers = await state.storage.list<{ resultReceivedAt: number }>({ prefix: "inbox:result:" })
    const deadlineAt = [...buffers.values()][0]!.resultReceivedAt + 1
    await Effect.runPromise(Effect.sleep(5))
    const reopened = make()
    await Effect.runPromise(reopened.accept(completion))
    await Effect.runPromise(reopened.watch({ ...request, deadlineAt }))
    await Effect.runPromise(reopened.alarm)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.result).toEqual(completion.result)
  })
})

test("Promise resolver retains accepted legacy buffers without an arrival timestamp", async () => {
  const stub = namespace.getByName("buffered-legacy")
  await runInDurableObject(stub, async (_instance, state) => {
    const delivered: ResolutionSettled[] = []
    const resolver = createCloudflarePromiseResolver({ storage: state.storage, deliver: (_recipient, settlement) => Effect.sync(() => { delivered.push(settlement) }) })
    const completion = { handle: request.handle, result: { status: "fulfilled" as const, value: "legacy" } }
    await Effect.runPromise(resolver.accept(completion))
    const buffers = await state.storage.list<{ resultReceivedAt?: number }>({ prefix: "inbox:result:" })
    for (const [key, value] of buffers) {
      const { resultReceivedAt: _, ...legacy } = value
      await state.storage.put(key, legacy)
    }
    await Effect.runPromise(resolver.accept(completion))
    await Effect.runPromise(resolver.watch({ ...request, deadlineAt: Date.now() - 1_000 }))
    await Effect.runPromise(resolver.alarm)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.result).toEqual(completion.result)
  })
})
