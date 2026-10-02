import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Clock, Context, Deferred, Effect, Layer, Schema } from "effect"
import { RuntimeError, act, actorMethod, createWatchdog, defineActor, durableAtom, durablePromise, effectAtom, EffectExecution, ExecutionResult, event, watchdogKey } from "@clavia/tardigrade-core"
import { createCloudflareHost } from "../../src/cloudflare"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import type { TestPromiseResolver } from "./fixture.worker"

const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
const address = { actor: "test", instance: "main", thread: "one" }

// deferAlarms keeps staged alarms at least a minute out so the fixture's no-op alarm handler cannot consume them while a scenario drives the host alarm explicitly.
const deferAlarms = (storage: DurableObjectStorage) => new Proxy(storage, { get(target, property) {
  if (property === "transaction") return <Value>(callback: (tx: DurableObjectTransaction) => Promise<Value>) => target.transaction(tx => callback(new Proxy(tx, { get(transaction, key) {
    if (key === "setAlarm") return (at: number) => transaction.setAlarm(Math.max(at, Date.now() + 60_000))
    const value = Reflect.get(transaction, key)
    return typeof value === "function" ? value.bind(transaction) : value
  } })))
  const value = Reflect.get(target, property)
  return typeof value === "function" ? value.bind(target) : value
} })

test("watchdog synchronizes the replacement before recovery", async () => {
  await runInDurableObject(namespace.getByName("watchdog-sync"), async (_instance, state) => {
    let flushed = false
    const storage = new Proxy(state.storage, { get(target, property) {
      if (property === "sync") return async () => { await target.sync(); flushed = true }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const db = cloudflareWatchdogStorage(storage)
    const watchdog = createWatchdog({ storage: db, policy: { attemptTimeoutMs: 100 }, invalidate: () => Effect.void, recover: () => Effect.gen(function* () {
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

test("Cloudflare host recovers accepted work after runtime restart", async () => {
  await runInDurableObject(namespace.getByName("watchdog-host"), async (_instance, state) => {
    const Started = event({ type: "Started" })
    const Finished = event({ type: "Finished" })
    const Event = Schema.Union([Started, Finished])
    const Job = act({ name: "host.test.job", input: Schema.Null, success: Schema.Null, failure: Schema.String })
    const progress = durableAtom({ name: "host.test.state", input: Event, schema: Schema.Struct({ started: Schema.Boolean, done: Schema.Boolean }), initial: { started: false, done: false }, reduce: (s, e) => e.type === "Started" ? { ...s, started: true } : { ...s, done: true } })
    const actor = defineActor("test", Effect.sync(() => {
      const job = Job.request({ tag: "job", input: null, onSettled: () => [Finished.make({})] })
      return { atom: effectAtom(get => { const view = get(progress); return { view, events: {}, acts: view.started && !view.done ? { job } : {} } }), methods: { start: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Boolean, onReceive: Started.from(() => ({})), result: (_, get) => get(progress).done ? { status: "completed" as const, output: true } : undefined }) } }
    }))
    const storage = deferAlarms(state.storage)
    const entered = Deferred.makeUnsafe<void>()
    const first = createCloudflareHost({ actor, storage, actorContext: Context.pick(), services: () => Job.layer(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))) })
    const thread = await Effect.runPromise(first.allocateRootThread({ instance: "main", name: "one" }))
    await Effect.runPromise(thread.invoke("start", null, { id: "message" }))
    await Effect.runPromise(Deferred.await(entered))
    expect((await Effect.runPromise(first.watchdog.status)).get(watchdogKey(address))!.status).toBe("pending")
    expect(await state.storage.getAlarm()).not.toBeNull()
    await Effect.runPromise(first.close)
    let executions = 0
    const reopened = createCloudflareHost({ actor, storage, actorContext: Context.pick(), services: () => Job.layer(() => Effect.sync(() => { executions++; return null })) })
    try {
      const db = cloudflareWatchdogStorage(storage)
      await Effect.runPromise(db.transaction(tx => Effect.gen(function* () {
        const key = watchdogKey(address)
        const entry = yield* tx.get(key)
        yield* tx.put(key, { ...entry!, status: "blocked", nextWakeAt: null, reason: "operator review" })
      })))
      const paused = await Effect.runPromise(reopened.getThread({ instance: "main", thread: "one" }))
      await Effect.runPromise(paused!.wait)
      expect(executions).toBe(0)
      await Effect.runPromise(reopened.watchdog.resume(address))
      await Effect.runPromise(reopened.alarm)
      const recovered = await Effect.runPromise(reopened.getThread({ instance: "main", thread: "one" }))
      expect(await Effect.runPromise(recovered!.result("start", "message"))).toEqual({ status: "completed", output: true })
      expect(executions).toBe(1)
      await Effect.runPromise(Effect.gen(function* () {
        while ((yield* reopened.watchdog.status).size) yield* Effect.sleep(1)
      }).pipe(Effect.timeout(1_000)))
      expect((await Effect.runPromise(reopened.watchdog.status)).size).toBe(0)
      expect(await state.storage.getAlarm()).toBeNull()
    } finally { await Effect.runPromise(reopened.close) }
  })
})

test("Cloudflare host rolls back journal admission when alarm staging fails", async () => {
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
    const actor = defineActor("test", Effect.succeed({ schema: Schema.Struct({ type: Schema.Literal("Tick") }), atom: effectAtom(() => ({ view: null, events: {}, acts: {} })) }))
    const host = createCloudflareHost({ actor, storage, actorContext: Context.pick(), services: () => Layer.empty })
    try {
      await expect(Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))).rejects.toThrow()
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM experimental_events").one().count).toBe(0)
      expect((await state.storage.list({ prefix: "tardie:watchdog:" })).size).toBe(0)
    } finally { await Effect.runPromise(host.close) }
  })
})

test("Cloudflare heartbeats keep live local work without renewing its deadline", async () => {
  await runInDurableObject(namespace.getByName("watchdog-live-fibre"), async (_instance, state) => {
    const Started = event({ type: "Started" })
    const Finished = event({ type: "Finished" })
    const Event = Schema.Union([Started, Finished])
    const Job = act({ name: "host.test.live", input: Schema.Null, success: Schema.Null, failure: Schema.String })
    const actor = defineActor("test", Effect.sync(() => {
      const progress = durableAtom({ name: "live", input: Event, schema: Schema.Struct({ started: Schema.Boolean, done: Schema.Boolean }), initial: { started: false, done: false }, reduce: (s, e) => e.type === "Started" ? { ...s, started: true } : { ...s, done: true } })
      const request = Job.request({ tag: "job", input: null, onSettled: () => [Finished.make({})] })
      return { atom: effectAtom(get => { const view = get(progress); return { view, events: {}, acts: view.started && !view.done ? { job: request } : {} } }), methods: { start: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Boolean, onReceive: Started.from(() => ({})), result: (_, get) => get(progress).done ? { status: "completed" as const, output: true } : undefined }) } }
    }))
    const release = Deferred.makeUnsafe<void>()
    let executions = 0
    const host = createCloudflareHost({ actor, storage: deferAlarms(state.storage), promises: { timeoutMs: 10 }, watchdog: { policy: { keepAliveIntervalMs: 5, attemptTimeoutMs: 20 } }, actorContext: Context.pick(), services: () => Job.layer(() => Effect.gen(function* () {
      executions++
      const execution = yield* EffectExecution
      const promise = durablePromise(execution.ref, { success: Schema.Null, error: Schema.String })
      const handle = yield* execution.fork(Deferred.await(release).pipe(Effect.as(promise.succeed(null))), { timeoutMs: 1_000 })
      return Job.defer(handle)
    }).pipe(Effect.mapError(String))) })
    try {
      const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
      await Effect.runPromise(thread.invoke("start", null, { id: "message" }))
      const deadline = async () => {
        const record = (await Effect.runPromise(thread.records())).find(({ event }) => event.type === "EffectSettled")?.event
        if (record?.type !== "EffectSettled" || record.outcome.status !== "fulfilled") return undefined
        const value = Schema.decodeUnknownSync(ExecutionResult)(record.outcome.value)
        return value.type === "promise" ? value.deadlineAt : undefined
      }
      while (await deadline() === undefined) await Effect.runPromise(Effect.sleep(1))
      const recordedDeadline = await deadline()
      for (let index = 0; index < 5; index++) {
        await Effect.runPromise(Effect.sleep(8))
        await Effect.runPromise(host.alarm)
        const entry = (await Effect.runPromise(host.watchdog.status)).get(watchdogKey(address))!
        expect(entry.attempts).toBe(0)
        expect(entry.consecutiveNoProgress).toBe(0)
        expect(await deadline()).toBe(recordedDeadline)
        expect(await state.storage.getAlarm()).not.toBeNull()
      }
      expect(executions).toBe(1)
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await Effect.runPromise(thread.wait)
      await Effect.runPromise(Effect.sleep(8))
      await Effect.runPromise(host.alarm)
      expect((await Effect.runPromise(host.watchdog.status)).size).toBe(0)
      expect(await state.storage.getAlarm()).toBeNull()
    } finally { await Effect.runPromise(host.close) }
  })
})
