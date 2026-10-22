import assert from "node:assert/strict"
import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { test } from "vitest"
import * as fc from "fast-check"
import { TestClock } from "effect/testing"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { RuntimeError, ExecutionResult, PromiseSettled, Scheduler, createScheduler, createWatchdog, effectKey, watchdogKey, type RecoveryState } from "@clavia/tardigrade-core"
import { objectJournal } from "../../src/cloudflare/objects"
import { cloudflareSchedulerStorage } from "../../src/cloudflare/scheduler"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import { slowActor, slowServices } from "../fixtures/slow-act"
import { createTestStore } from "../properties/runtime/store"
import type { TestPromiseResolver } from "../fixtures/workerd/fixture.worker"

const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
let instances = 0

const promiseDeadlineRecovery = (storage: DurableObjectStorage, { budget, slackMs, legacy }: { readonly budget: number; readonly slackMs: number; readonly legacy: boolean }) => Effect.gen(function* () {
  const clock = yield* TestClock.make()
  yield* Effect.gen(function* () {
    const timeoutMs = budget + slackMs
    const fixture = slowServices({ workMs: timeoutMs, value: 42, hold: true, fork: { timeoutMs } })
    const target = { actor: "deadline", instance: "main", thread: "one" }
    const closes: Array<Effect.Effect<void>> = []
    const alarmAt = () => Effect.promise(() => storage.list<{ readonly dueAt: number }>({ prefix: "tardie:scheduler:" })).pipe(Effect.map(wakes => wakes.size ? Math.min(...[...wakes.values()].map(wake => wake.dueAt)) : null))
    let probe: (() => RecoveryState) | undefined
    let attempts = 0
    const open = () => {
      const watchdog = createWatchdog({ storage: cloudflareWatchdogStorage(storage), policy: { maxAttempts: budget, maxNoProgressAttempts: budget, retryIntervalMs: 1, maxRetryIntervalMs: 1 },
        recover: () => Effect.suspend(() => { attempts++; return Effect.fail(new RuntimeError("Producer isolate reset")) }),
        invalidate: () => Effect.void, probe: () => Effect.sync(() => probe?.()),
      })
      const scheduler = createScheduler({ storage: cloudflareSchedulerStorage(storage), deliver: wake => Effect.gen(function* () {
        if (typeof wake.target === "object" && wake.target !== null && "owner" in wake.target && wake.target.owner === "effect") {
          const restored = yield* runtime()
          probe = restored.recoveryState
          yield* restored.recover
        } else yield* watchdog.alarm
      }) })
      const journal = objectJournal<{ type: "RunRequested" }>({ storage, key: "events", target, watchdog })
      return { watchdog, scheduler, journal }
    }
    let host = open()
    const runtime = () => createTestStore({ actor: slowActor, journal: host.journal, checkpoint: { mode: "manual" },
      canDrive: host.watchdog.blocked(target).pipe(Effect.map(blocked => !blocked)),
      actorContext: Context.pick(), services: () => Layer.merge(fixture.services, Layer.succeed(Scheduler, host.scheduler)),
    }).pipe(Effect.tap(store => Effect.sync(() => { closes.push(store.close.pipe(Effect.orDie)) })))
    yield* Effect.gen(function* () {
      const initial = yield* runtime()
      yield* initial.send([{ type: "RunRequested" }])
      yield* fixture.started(1)
      while (!initial.snapshot().deferred().length) yield* Effect.yieldNow
      const settled = initial.snapshot().events.find(event => event.type === "EffectSettled")
      if (!settled || settled.type !== "EffectSettled" || settled.outcome.status !== "fulfilled") return yield* Effect.fail(new RuntimeError("Missing promise envelope"))
      const envelope = yield* Schema.decodeUnknownEffect(ExecutionResult)(settled.outcome.value)
      if (envelope.type !== "promise" || envelope.deadlineAt === undefined) return yield* Effect.fail(new RuntimeError("Missing promise deadline"))
      const deadlineAt = envelope.deadlineAt
      yield* initial.close
      for (let index = 0; index < budget; index++) {
        const at = yield* alarmAt()
        if (at === null) return yield* Effect.fail(new RuntimeError("Recovery wake disappeared before budget exhaustion"))
        yield* clock.setTime(at)
        yield* host.scheduler.alarm
      }
      assert.equal(attempts, budget)
      assert.equal((yield* host.watchdog.status).get(watchdogKey(target))?.status, "blocked")
      assert((yield* Clock.currentTimeMillis) < deadlineAt)
      const records = yield* host.journal.read
      if (legacy) {
        yield* host.scheduler.cancel(`promise:${effectKey(settled.ref)}`)
        const upgraded = yield* runtime()
        yield* upgraded.recover
        yield* upgraded.close
      }
      yield* host.journal.close
      host = open()
      yield* host.scheduler.restore
      yield* host.watchdog.restore
      assert.deepEqual(yield* host.journal.read, records)
      assert.equal(records.some(record => record.event.type === "PromiseSettled"), false)
      const armed = yield* alarmAt()
      assert.notEqual(armed, null, "Unsettled promise lost its deadline wake when recovery blocked")
      assert(armed! <= deadlineAt)
      yield* clock.setTime(deadlineAt)
      yield* host.scheduler.alarm
      yield* host.scheduler.alarm
      const final = yield* host.journal.read
      const timeouts = final.map(record => record.event).filter(Schema.is(PromiseSettled))
      assert.equal(timeouts.length, 1)
      assert.deepEqual(timeouts[0]!.result, { status: "rejected", reason: { _tag: "PromiseTimedOut", deadlineAt } })
      assert.equal(fixture.log().filter(entry => entry.kind === "start").length, 1)
      assert.equal((yield* host.watchdog.status).size, 0)
      assert.equal(yield* alarmAt(), null)
      yield* Effect.forEach(closes, close => close)
      probe = undefined
      const completed = yield* runtime()
      yield* completed.recover
      assert.equal((yield* host.journal.read).filter(record => Schema.is(PromiseSettled)(record.event)).length, 1)
      assert.equal(fixture.log().filter(entry => entry.kind === "start").length, 1)
    }).pipe(Effect.ensuring(Effect.suspend(() => Effect.forEach(closes, close => close).pipe(Effect.andThen(host.journal.close), Effect.orDie))))
  }).pipe(Effect.provideService(Clock.Clock, clock))
}).pipe(Effect.scoped)

test("recovery: promise deadlines survive watchdog exhaustion", async () => {
  await fc.assert(fc.asyncProperty(fc.record({ budget: fc.integer({ min: 1, max: 5 }), slackMs: fc.integer({ min: 10, max: 1_000 }), legacy: fc.boolean() }), value =>
    runInDurableObject(namespace.getByName(`promise-deadline-${instances++}`), (_instance, state) => Effect.runPromise(promiseDeadlineRecovery(state.storage, value)))), { numRuns: 20 })
}, 60_000)
