import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Context, Deferred, Effect, Layer, Logger, References, Schema } from "effect"
import { act, actorMethod, createActorStore, createWatchdog, defineActor, durableAtom, effectAtom, event, RuntimeError, watchdogKey, WatchdogTerminalError, DEFAULT_WATCHDOG_POLICY } from "@clavia/tardigrade-core"
import { initializeThread, updateThreadVersion } from "@clavia/tardigrade-core/services/journal/thread"
import { createActorObjects, objectJournal, type CloudflareObjectBindings } from "../../src/cloudflare/objects"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import type { TestPromiseResolver } from "../fixtures/workerd/fixture.worker"

const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
const address = { actor: "versioned", instance: "main", thread: "one" }
const Requested = event({ type: "Requested", value: Schema.Finite })
const value = durableAtom({ name: "versioned.value", input: Requested, schema: Schema.NullOr(Schema.Finite), initial: null, reduce: (_, event) => event.value })
const Work = act({ name: "versioned.work", input: Schema.Finite, success: Schema.Finite, failure: Schema.String })
const actor = defineActor("versioned", Effect.sync(() => {
  let request: ReturnType<typeof Work.request> | undefined
  return { atom: effectAtom(get => {
    const input = get(value)
    if (input === null) return { view: null, events: {}, acts: {} }
    request ??= Work.request({ input })
    return { view: get(request.result), events: {}, acts: { work: request } }
  }), methods: { run: actorMethod({ inputSchema: Schema.Finite, outputSchema: Schema.Finite,
    onReceive: Requested.from(value => ({ value })), result: () => undefined,
  }) } }
}))
const brokenActor = defineActor("versioned", Effect.succeed({ schema: Schema.Struct({ type: Schema.Literal("Requested") }), atom: effectAtom(() => ({ view: null, events: {}, acts: {} })) }))

for (const legacy of [false, true]) test(`a fixed interpreter recovers a blocked inline effect (${legacy ? "legacy" : "versioned"} budget)`, async () => {
  await runInDurableObject(namespace.getByName(`interpreter-${legacy}`), async (_object, state) => {
    const storage = cloudflareWatchdogStorage(state.storage)
    const watchdog = createWatchdog({ storage, ...(legacy ? {} : { version: "v1" }), policy: { maxNoProgressAttempts: 1 }, invalidate: () => Effect.void,
      recover: () => Effect.acquireUseRelease(createActorStore({ actor: brokenActor, journal, actorContext: Context.pick(), services: () => Layer.empty }), store => store.recover.pipe(Effect.as({ status: "settled" as const, progressCursor: 0 })), store => store.close),
    })
    const journal = objectJournal({ storage: state.storage, key: "events", target: address, watchdog })
    await Effect.runPromise(initializeThread(journal, { type: "ThreadCreated", address, parent: null, depth: 0, placement: "independent", ...(legacy ? {} : { version: "v1" }) }))
    const entered = Deferred.makeUnsafe<void>()
    const first = await Effect.runPromise(createActorStore({ actor, journal, actorContext: Context.pick(), services: () => Work.layer(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))) }))
    try {
      await Effect.runPromise(first.receive({ method: "run", input: 42 }, { id: "run", from: { kind: "external", id: "test" } }))
      await Effect.runPromise(Deferred.await(entered))
    } finally { await Effect.runPromise(first.close) }
    const prefix = await Effect.runPromise(journal.read)
    expect(prefix.some(record => "type" in record.event && record.event.type === "EffectRequested")).toBe(true)
    await Effect.runPromise(watchdog.alarm)
    const blocked = (await Effect.runPromise(watchdog.status)).get(watchdogKey(address))!
    expect(blocked.status).toBe("blocked")
    if (!legacy) {
      await Effect.runPromise(updateThreadVersion(journal, address, "v1"))
      await Effect.runPromise(watchdog.restore)
      expect((await Effect.runPromise(watchdog.status)).get(watchdogKey(address))).toEqual(blocked)
      expect(await state.storage.getAlarm()).toBeNull()
    }
    const rejected = objectJournal({ storage: state.storage, key: "events", target: address,
      watchdog: { ...watchdog, admit: () => Effect.fail(new RuntimeError("Reject version transaction")) },
    })
    try {
      await expect(Effect.runPromise(updateThreadVersion(rejected, address, "v2"))).rejects.toThrow("Reject version transaction")
      expect(await Effect.runPromise(journal.read)).toEqual(prefix)
      expect((await Effect.runPromise(watchdog.status)).get(watchdogKey(address))).toEqual(blocked)
      expect(await state.storage.getAlarm()).toBeNull()
    } finally { await Effect.runPromise(rejected.close) }
    await Effect.runPromise(updateThreadVersion(journal, address, "v2"))
    const renewed = (await Effect.runPromise(watchdog.status)).get(watchdogKey(address))!
    expect(renewed).toMatchObject({ status: "pending", recoveryVersion: "v2", attempts: 0, consecutiveNoProgress: 0, budgetGeneration: 1 })
    expect(await state.storage.getAlarm()).not.toBeNull()
    expect((await Effect.runPromise(journal.read)).slice(0, prefix.length)).toEqual(prefix)
    const brokenVersion = createWatchdog({ storage, version: "v2", policy: { maxNoProgressAttempts: 1 }, invalidate: () => Effect.void,
      recover: () => Effect.acquireUseRelease(createActorStore({ actor: brokenActor, journal, actorContext: Context.pick(), services: () => Layer.empty }), store => store.recover.pipe(Effect.as({ status: "settled" as const, progressCursor: 0 })), store => store.close),
    })
    await Effect.runPromise(brokenVersion.alarm)
    const stillBlocked = (await Effect.runPromise(watchdog.status)).get(watchdogKey(address))!
    expect(stillBlocked).toMatchObject({ status: "blocked", recoveryVersion: "v2", budgetGeneration: 1 })
    const unchanged = createWatchdog({ storage, version: "v2", invalidate: () => Effect.void, recover: () => Effect.die("Same-version recovery must stay blocked") })
    await Effect.runPromise(unchanged.restore.pipe(Effect.andThen(unchanged.alarm)))
    expect((await Effect.runPromise(unchanged.status)).get(watchdogKey(address))).toEqual(stillBlocked)
    const order: string[] = []
    const warnings: Readonly<Record<string, unknown>>[] = []
    const logger = Logger.make(options => {
      if (options.logLevel === "Warn") {
        order.push("warning")
        warnings.push(options.fiber.getRef(References.CurrentLogAnnotations))
      }
    })
    const loggers = new Set([logger])
    await Effect.runPromise(updateThreadVersion(journal, address, "v3").pipe(Effect.provideService(Logger.CurrentLoggers, loggers)))
    await Effect.runPromise(updateThreadVersion(journal, address, "v3").pipe(Effect.provideService(Logger.CurrentLoggers, loggers)))
    expect(warnings).toEqual([{ ...address, previousVersion: "v2", version: "v3", pendingEffects: 1 }])
    expect((await Effect.runPromise(watchdog.status)).get(watchdogKey(address))).toMatchObject({ status: "pending", recoveryVersion: "v3", budgetGeneration: 2 })
    let executions = 0
    const fixed = createWatchdog({ storage, version: "v3", invalidate: () => Effect.void,
      recover: () => Effect.acquireUseRelease(createActorStore({ actor, journal, actorContext: Context.pick(), services: () => Work.layer(input => Effect.sync(() => { executions++; order.push("effect"); return input })) }), store => store.recover.pipe(Effect.andThen(store.wait), Effect.map(() => store.recoveryState())), store => store.close),
    })
    await Effect.runPromise(fixed.restore.pipe(Effect.andThen(fixed.alarm)))
    expect(executions).toBe(1)
    expect(order).toEqual(["warning", "effect"])
    expect((await Effect.runPromise(fixed.status)).size).toBe(0)
    expect((await Effect.runPromise(journal.read)).filter(record => "type" in record.event && record.event.type === "EffectRequested")).toHaveLength(1)
    await Effect.runPromise(journal.close)
  })
})

for (const scenario of ["uncreated", "blocked", "pending", "exhausted"] as const) test(`object activation adopts a version with ${scenario} recovery`, async () => {
  const created = scenario !== "uncreated"
  await runInDurableObject(namespace.getByName(`version-activation-${scenario}`), async (_object, state) => {
    const storage = cloudflareWatchdogStorage(state.storage)
    const watchdog = createWatchdog({ storage, version: "v1", invalidate: () => Effect.void, recover: () => Effect.fail(new WatchdogTerminalError("Old interpreter")) })
    if (created) {
      const journal = objectJournal({ storage: state.storage, key: "events", target: address, watchdog })
      try {
        await Effect.runPromise(initializeThread(journal, { type: "ThreadCreated", address, parent: null, depth: 0, placement: "independent", version: "v1" }))
        if (scenario === "blocked") await Effect.runPromise(watchdog.alarm)
        else await Effect.runPromise(storage.transaction(tx => Effect.gen(function* () {
          const entry = (yield* tx.get(watchdogKey(address)))!
          yield* tx.put(watchdogKey(address), { ...entry, attempts: scenario === "exhausted" ? DEFAULT_WATCHDOG_POLICY.maxAttempts : 1 })
        })))
      } finally { await Effect.runPromise(journal.close) }
    }
    await state.storage.put("tardie:thread:coordinate", address)
    const objects = createActorObjects({ actor, version: () => "v2", actorContext: Context.pick(), services: () => Work.layer(input => Effect.succeed(input)) })
    const instance = new objects.ThreadObject(state, env as unknown as Record<string, unknown> & CloudflareObjectBindings)
    try {
      const records = await instance.records()
      expect(records.map(record => record.event)).toEqual(created ? [
        { type: "ThreadCreated", address, parent: null, depth: 0, placement: "independent", version: "v1" },
        { type: "ThreadUpdated", version: "v2" },
      ] : [])
      if (created) expect((await Effect.runPromise(watchdog.status)).get(watchdogKey(address))).toMatchObject({ status: "pending", recoveryVersion: "v2", attempts: 0, budgetGeneration: 1 })
    } finally { await instance.dispose() }
  })
})
