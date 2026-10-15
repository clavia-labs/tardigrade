import { expect, test } from "bun:test"
import { Clock, Deferred, Effect, Fiber, Scope } from "effect"
import { createWatchdog, watchdogKey, watchdogPolicy, WatchdogTerminalError, type RecoveryState } from "@clavia/tardigrade-core"

import * as fc from "fast-check"
import { slowExecutionRecovery } from "../properties/watchdog/slow-execution"
import { RUNTIME_PROPERTY_OPTIONS } from "../properties/runtime/config"
import { memoryWatchdog as memory } from "../fixtures/watchdog"

const target = { actor: "test", instance: "main", thread: "one" }

const policy = { retryIntervalMs: 2, maxRetryIntervalMs: 4, attemptTimeoutMs: 20, maxAttempts: 3, maxNoProgressAttempts: 2 }
const pause = () => Effect.sleep(5)

test("watchdog precharges before execution, survives interruption, and bounds recovery", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = memory()
    const entered = yield* Deferred.make<void>()
    const first = createWatchdog({ storage: db.storage, policy, invalidate: () => Effect.void, recover: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) })
    yield* db.storage.transaction(tx => first.admit(tx, target))
    const fiber = yield* Effect.forkScoped(first.alarm)
    yield* Deferred.await(entered)
    expect(db.records().get(watchdogKey(target))!.attempts).toBe(1)
    expect(db.alarm()).toBeGreaterThan(yield* Clock.currentTimeMillis)
    yield* Fiber.interrupt(fiber)
    yield* Effect.sleep(25)
    let attempts = 0
    const reopened = createWatchdog({ storage: db.storage, policy, invalidate: () => Effect.void, recover: () => Effect.sync(() => { attempts++; return { status: "pending" as const, progressCursor: 0 } }) })
    yield* reopened.alarm
    expect(attempts).toBe(1)
    expect(db.records().get(watchdogKey(target))!.status).toBe("blocked")
    expect(db.alarm()).toBeNull()
    yield* reopened.alarm
    expect(attempts).toBe(1)
    yield* db.storage.transaction(tx => reopened.admit(tx, target))
    expect(db.records().get(watchdogKey(target))!.status).toBe("blocked")
    yield* reopened.resume(target)
    expect(db.records().get(watchdogKey(target))!.attempts).toBe(0)
    expect(db.alarm()).not.toBeNull()
  }).pipe(Effect.scoped))
})

test("watchdog resets consecutive failures on progress and retains its total budget", async () => {
  const db = memory()
  let progressCursor = 0
  const watchdog = createWatchdog({ storage: db.storage, policy, invalidate: () => Effect.void, recover: () => Effect.sync(() => ({ status: "pending" as const, progressCursor: ++progressCursor })) })
  await Effect.runPromise(db.storage.transaction(tx => watchdog.admit(tx, target)))
  for (let index = 0; index < 3; index++) { await Effect.runPromise(watchdog.alarm); await Effect.runPromise(pause()) }
  const entry = db.records().get(watchdogKey(target))!
  expect(entry.attempts).toBe(3)
  expect(entry.status).toBe("blocked")
  expect(db.alarm()).toBeNull()
})

test("watchdog blocks terminal failures and hung attempts", async () => {
  for (const recover of [() => Effect.fail(new WatchdogTerminalError("invalid state")), () => Effect.never]) {
    const db = memory()
    let invalidated = 0
    const watchdog = createWatchdog({ storage: db.storage, policy: { ...policy, maxNoProgressAttempts: 1 }, recover, invalidate: () => Effect.sync(() => { invalidated++ }) })
    await Effect.runPromise(db.storage.transaction(tx => watchdog.admit(tx, target)))
    await Effect.runPromise(watchdog.alarm)
    expect(db.records().get(watchdogKey(target))!.status).toBe("blocked")
    expect(db.alarm()).toBeNull()
    expect(invalidated).toBe(1)
  }
})

test("watchdog preserves a later admission and parks remote waits until their deadline", async () => {
  const db = memory()
  let later = true
  let state: RecoveryState = { status: "settled", progressCursor: 1 }
  let watchdog!: ReturnType<typeof createWatchdog>
  watchdog = createWatchdog({ storage: db.storage, policy, invalidate: () => Effect.void, recover: () => Effect.gen(function* () {
    if (later) { later = false; yield* db.storage.transaction(tx => watchdog.admit(tx, target, 3)) }
    return state
  }) })
  await Effect.runPromise(db.storage.transaction(tx => watchdog.admit(tx, target)))
  await Effect.runPromise(watchdog.alarm)
  expect(db.records().size).toBe(1)
  expect(db.records().get(watchdogKey(target))!.progressCursor).toBe(3)
  await Effect.runPromise(pause())
  state = { status: "parked", progressCursor: 1, wakeAt: Date.now() + 100 }
  await Effect.runPromise(watchdog.alarm)
  expect(db.alarm()).toBe(state.wakeAt!)
  expect(db.records().get(watchdogKey(target))!.progressCursor).toBe(3)
  expect(db.records().get(watchdogKey(target))!.consecutiveNoProgress).toBe(0)
  await Effect.runPromise(watchdog.alarm)
  expect(db.records().get(watchdogKey(target))!.attempts).toBe(2)
})

test("watchdog policies are host configurable and validated", () => {
  expect(() => watchdogPolicy({ maxAttempts: 0 })).toThrow()
  expect(() => watchdogPolicy({ maxRetryIntervalMs: 1, retryIntervalMs: 2 })).toThrow()
})

test("live promise heartbeats preserve the deadline and recovery budget", async () => {
  const db = memory()
  const deadline = Date.now() + 500
  let state: RecoveryState = { status: "running", progressCursor: 1, wakeAt: deadline }
  let executions = 0
  const watchdog = createWatchdog({ storage: db.storage, policy: { ...policy, keepAliveIntervalMs: 5 }, probe: () => Effect.succeed(state),
    recover: () => Effect.sync(() => { executions++; return state }), invalidate: () => Effect.void })
  await Effect.runPromise(db.storage.transaction(tx => watchdog.admit(tx, target, 1)))
  for (let index = 0; index < 8; index++) {
    await Effect.runPromise(watchdog.alarm)
    const entry = db.records().get(watchdogKey(target))!
    expect(entry.attempts).toBe(0)
    expect(entry.consecutiveNoProgress).toBe(0)
    expect(entry.progressCursor).toBe(1)
    expect(db.alarm()!).toBeLessThanOrEqual(deadline)
    await Effect.runPromise(Effect.sleep(6))
  }
  expect(executions).toBe(0)
  state = { status: "settled", progressCursor: 2 }
  await Effect.runPromise(watchdog.alarm)
  expect(db.records().size).toBe(0)
  expect(db.alarm()).toBeNull()
})

test("alarm returns while recovery runs and heartbeats do not launch duplicates", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = memory()
    const scope = yield* Scope.Scope
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let executions = 0
    const watchdog = createWatchdog({ storage: db.storage, policy: { ...policy, attemptTimeoutMs: 500, keepAliveIntervalMs: 5 },
      launch: work => Effect.forkIn(work, scope).pipe(Effect.asVoid), invalidate: () => Effect.void,
      recover: () => Effect.gen(function* () {
        executions++
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return { status: "settled" as const, progressCursor: 1 }
      }) })
    yield* db.storage.transaction(tx => watchdog.admit(tx, target))
    yield* watchdog.alarm
    yield* Deferred.await(entered)
    for (let index = 0; index < 4; index++) {
      yield* Effect.sleep(6)
      yield* watchdog.alarm
      expect(db.records().get(watchdogKey(target))!.attempts).toBe(1)
    }
    expect(executions).toBe(1)
    yield* Deferred.succeed(release, undefined)
    while (db.records().size) yield* Effect.sleep(1)
    expect(db.alarm()).toBeNull()
  }).pipe(Effect.scoped, Effect.timeout(2_000)))
})

test("an expired live promise returns to bounded recovery", async () => {
  const db = memory()
  const state: RecoveryState = { status: "running", progressCursor: 0, wakeAt: Date.now() - 1 }
  let executions = 0
  const watchdog = createWatchdog({ storage: db.storage, policy, probe: () => Effect.succeed(state),
    recover: () => Effect.sync(() => { executions++; return state }), invalidate: () => Effect.void })
  await Effect.runPromise(db.storage.transaction(tx => watchdog.admit(tx, target)))
  for (let index = 0; index < 3; index++) { await Effect.runPromise(watchdog.alarm); await Effect.runPromise(pause()) }
  expect(executions).toBe(2)
  expect(db.records().get(watchdogKey(target))!.status).toBe("blocked")
  expect(db.alarm()).toBeNull()
})

test("explicit resume fences an older failure while admissions retain terminal failures", async () => {
  for (const resume of [true, false]) {
    await Effect.runPromise(Effect.gen(function* () {
      const db = memory()
      const scope = yield* Scope.Scope
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      let invalidated = 0
      const watchdog = createWatchdog({ storage: db.storage, policy: { attemptTimeoutMs: 1_000 },
        launch: work => Effect.forkIn(work.pipe(Effect.ensuring(Deferred.succeed(completed, undefined))), scope).pipe(Effect.asVoid),
        invalidate: () => Effect.sync(() => { invalidated++ }),
        recover: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.fail(new WatchdogTerminalError("old failure")))),
      })
      yield* db.storage.transaction(tx => watchdog.admit(tx, target))
      yield* watchdog.alarm
      yield* Deferred.await(entered)
      if (resume) yield* watchdog.resume(target)
      else yield* db.storage.transaction(tx => watchdog.admit(tx, target))
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(completed)
      const entry = db.records().get(watchdogKey(target))!
      expect(entry.generation).toBe(2)
      expect(entry.status).toBe(resume ? "pending" : "blocked")
      expect(entry.attempts).toBe(resume ? 0 : 1)
      expect(invalidated).toBe(resume ? 0 : 1)
      if (resume) expect(db.alarm()).not.toBeNull()
      else expect(db.alarm()).toBeNull()
    }).pipe(Effect.scoped, Effect.timeout(2_000)))
  }
})

test("an older finish cannot release a newer recovery heartbeat", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const finishCommitted = yield* Deferred.make<void>()
    const flush = yield* Deferred.make<void>()
    const firstCompleted = yield* Deferred.make<void>()
    const secondEntered = yield* Deferred.make<void>()
    let delayFinish = false
    const db = memory(Effect.suspend(() => {
      if (!delayFinish) return Effect.void
      delayFinish = false
      return Deferred.succeed(finishCommitted, undefined).pipe(Effect.andThen(Deferred.await(flush)))
    }))
    let launches = 0
    let executions = 0
    const watchdog = createWatchdog({ storage: db.storage, policy: { attemptTimeoutMs: 1_000, keepAliveIntervalMs: 5, retryIntervalMs: 1 },
      launch: work => {
        const launched = launches++ === 0 ? work.pipe(Effect.ensuring(Deferred.succeed(firstCompleted, undefined))) : work
        return Effect.forkIn(launched, scope).pipe(Effect.asVoid)
      },
      invalidate: () => Effect.void,
      recover: () => Effect.gen(function* () {
        if (++executions === 1) {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return { status: "pending" as const, progressCursor: 0 }
        }
        yield* Deferred.succeed(secondEntered, undefined)
        return yield* Effect.never
      }),
    })
    yield* db.storage.transaction(tx => watchdog.admit(tx, target))
    yield* watchdog.alarm
    yield* Deferred.await(entered)
    delayFinish = true
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(finishCommitted)
    yield* db.storage.transaction(tx => Effect.gen(function* () {
      const key = watchdogKey(target)
      const entry = yield* tx.get(key)
      yield* tx.put(key, { ...entry!, nextWakeAt: 0 })
    }))
    yield* watchdog.alarm
    yield* Deferred.await(secondEntered)
    yield* Deferred.succeed(flush, undefined)
    yield* Deferred.await(firstCompleted)
    db.consumeAlarm()
    yield* watchdog.alarm
    expect(executions).toBe(2)
    expect(db.records().get(watchdogKey(target))!.attempts).toBe(2)
    expect(db.alarm()).not.toBeNull()
  }).pipe(Effect.scoped, Effect.timeout(2_000)))
})

test("resume waits for validated invalidation before resetting the budget", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const db = memory()
    const invalidating = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const resuming = yield* Deferred.make<void>()
    const resumed = yield* Deferred.make<void>()
    const watchdog = createWatchdog({ storage: db.storage,
      launch: work => Effect.forkIn(work, scope).pipe(Effect.asVoid),
      recover: () => Effect.fail(new WatchdogTerminalError("failed")),
      invalidate: () => Deferred.succeed(invalidating, undefined).pipe(Effect.andThen(Deferred.await(release))),
    })
    yield* db.storage.transaction(tx => watchdog.admit(tx, target))
    yield* watchdog.alarm
    yield* Deferred.await(invalidating)
    const resume = yield* Deferred.succeed(resuming, undefined).pipe(Effect.andThen(watchdog.resume(target)), Effect.andThen(Deferred.succeed(resumed, undefined)), Effect.forkIn(scope))
    yield* Deferred.await(resuming)
    expect(yield* Deferred.isDone(resumed)).toBe(false)
    expect(db.records().get(watchdogKey(target))!.attempts).toBe(1)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(resume)
    expect(db.records().get(watchdogKey(target))!.status).toBe("pending")
    expect(db.records().get(watchdogKey(target))!.attempts).toBe(0)
  }).pipe(Effect.scoped, Effect.timeout(2_000)))
})

test("watchdog preserves slow inline and forked execution across virtual-time restarts", () => fc.assert(slowExecutionRecovery, RUNTIME_PROPERTY_OPTIONS))


test("version restoration renews legacy budgets once across blocked and pending states", async () => {
  for (const status of ["blocked", "pending"] as const) {
    const db = memory()
    const watchdog = createWatchdog({ storage: db.storage, version: "v2", invalidate: () => Effect.void, recover: () => Effect.succeed({ status: "settled", progressCursor: 0 }) })
    await Effect.runPromise(db.storage.transaction(tx => tx.put(watchdogKey(target), { target, generation: 4, progressCursor: 2, attempts: 1, consecutiveNoProgress: 1, status, nextWakeAt: status === "blocked" ? null : 123 })))
    await Effect.runPromise(watchdog.restore)
    const adopted = db.records().get(watchdogKey(target))!
    expect(adopted).toMatchObject({ recoveryVersion: "v2", status: "pending", progressCursor: 2, attempts: 0, consecutiveNoProgress: 0, budgetGeneration: 1 })
    expect(db.alarm()).not.toBeNull()
    await Effect.runPromise(watchdog.restore)
    expect(db.records().get(watchdogKey(target))).toEqual(adopted)
  }
})

test("a changed interpreter recovers after a crash at either precharged budget limit", async () => {
  for (const counters of [{ attempts: 3, consecutiveNoProgress: 1 }, { attempts: 1, consecutiveNoProgress: 2 }]) {
    const db = memory()
    let executions = 0
    const watchdog = createWatchdog({ storage: db.storage, version: "v2", policy, invalidate: () => Effect.void,
      recover: () => Effect.sync(() => { executions++; return { status: "settled" as const, progressCursor: 1 } }),
    })
    await Effect.runPromise(db.storage.transaction(tx => tx.put(watchdogKey(target), { target, generation: 1, recoveryVersion: "v1", progressCursor: 0, ...counters, status: "pending", nextWakeAt: 0 })))
    await Effect.runPromise(watchdog.restore)
    expect(db.records().get(watchdogKey(target))).toMatchObject({ recoveryVersion: "v2", budgetGeneration: 1, attempts: 0, consecutiveNoProgress: 0, status: "pending" })
    await Effect.runPromise(watchdog.alarm)
    expect(executions).toBe(1)
    expect(db.records().size).toBe(0)
  }
})

test("a changed interpreter receives its full budget when pending work needs multiple recovery passes", async () => {
  const db = memory()
  let executions = 0
  const watchdog = createWatchdog({ storage: db.storage, version: "v2", policy: { ...policy, retryIntervalMs: 1 }, invalidate: () => Effect.void,
    recover: () => Effect.sync(() => ({ status: ++executions === 1 ? "pending" as const : "settled" as const, progressCursor: executions })),
  })
  await Effect.runPromise(db.storage.transaction(tx => tx.put(watchdogKey(target), { target, generation: 1, recoveryVersion: "v1", attempts: 2, consecutiveNoProgress: 1, progressCursor: 0, status: "pending", nextWakeAt: 0 })))
  await Effect.runPromise(watchdog.restore.pipe(Effect.andThen(watchdog.alarm)))
  expect(db.records().get(watchdogKey(target))).toMatchObject({ status: "pending", attempts: 1, recoveryVersion: "v2", budgetGeneration: 1 })
  await Effect.runPromise(pause().pipe(Effect.andThen(watchdog.alarm)))
  expect(executions).toBe(2)
  expect(db.records().size).toBe(0)
})

test("version adoption fences a late previous-interpreter failure before it can invalidate or block", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = memory()
    const scope = yield* Scope.Scope
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const finished = yield* Deferred.make<void>()
    let invalidated = 0
    const old = createWatchdog({ storage: db.storage, version: "v1", policy: { attemptTimeoutMs: 1_000 },
      launch: work => Effect.forkIn(work.pipe(Effect.ensuring(Deferred.succeed(finished, undefined))), scope).pipe(Effect.asVoid),
      invalidate: () => Effect.sync(() => { invalidated++ }),
      recover: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.fail(new WatchdogTerminalError("Old interpreter failed")))),
    })
    yield* old.restore
    yield* db.storage.transaction(tx => old.admit(tx, target))
    yield* old.alarm
    yield* Deferred.await(entered)
    const current = createWatchdog({ storage: db.storage, version: "v2", invalidate: () => Effect.void, recover: () => Effect.succeed({ status: "settled", progressCursor: 1 }) })
    yield* current.restore
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(finished)
    yield* old.restore.pipe(Effect.andThen(old.alarm))
    expect(invalidated).toBe(0)
    expect(db.records().get(watchdogKey(target))).toMatchObject({ status: "pending", recoveryVersion: "v2", attempts: 0, budgetGeneration: 1 })
    yield* current.alarm
    expect(db.records().size).toBe(0)
  }).pipe(Effect.scoped, Effect.timeout(2_000)))
})

test("an old probe cannot charge a newly adopted interpreter budget", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = memory()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let invalidated = 0
    let oldRecoveries = 0
    const old = createWatchdog({ storage: db.storage, version: "v1", policy: { maxNoProgressAttempts: 1 },
      probe: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.fail(new WatchdogTerminalError("Old probe failed")))),
      invalidate: () => Effect.sync(() => { invalidated++ }),
      recover: () => Effect.sync(() => { oldRecoveries++; return { status: "settled" as const, progressCursor: 0 } }),
    })
    yield* old.restore
    yield* db.storage.transaction(tx => old.admit(tx, target))
    const alarm = yield* Effect.forkScoped(old.alarm)
    yield* Deferred.await(entered)
    const current = createWatchdog({ storage: db.storage, version: "v2", invalidate: () => Effect.void, recover: () => Effect.succeed({ status: "settled", progressCursor: 1 }) })
    yield* current.restore
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(alarm)
    yield* old.restore.pipe(Effect.andThen(old.alarm))
    expect(invalidated).toBe(0)
    expect(oldRecoveries).toBe(0)
    expect(db.records().get(watchdogKey(target))).toMatchObject({ status: "pending", recoveryVersion: "v2", attempts: 0, budgetGeneration: 1 })
    yield* current.alarm
    expect(db.records().size).toBe(0)
  }).pipe(Effect.scoped, Effect.timeout(2_000)))
})

test("omitting version keeps existing versioned pending work recoverable", async () => {
  const db = memory()
  const old = createWatchdog({ storage: db.storage, version: "v1", invalidate: () => Effect.void, recover: () => Effect.never })
  await Effect.runPromise(db.storage.transaction(tx => old.admit(tx, target)))
  let executions = 0
  const unversioned = createWatchdog({ storage: db.storage, invalidate: () => Effect.void, recover: () => Effect.sync(() => { executions++; return { status: "settled" as const, progressCursor: 1 } }) })
  await Effect.runPromise(unversioned.restore.pipe(Effect.andThen(unversioned.alarm)))
  expect(executions).toBe(1)
  expect(db.records().size).toBe(0)
})
