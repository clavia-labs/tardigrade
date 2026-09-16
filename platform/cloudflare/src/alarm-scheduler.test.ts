import { expect, test } from "bun:test"
import { AlarmScheduler } from "./alarm-scheduler"

const fixture = () => {
  let alarm: number | null = null
  let persisted = false
  const storage = {
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => { alarm = at; persisted = false },
    sync: async () => { persisted = true }
  }
  const scheduler = new AlarmScheduler(storage, 60_000)
  return {
    scheduler, storage,
    alarm: () => alarm,
    persisted: () => persisted,
    fire: (execute: () => Promise<void>, synchronize = async () => { alarm = null }) => {
      alarm = null
      return scheduler.run(execute, synchronize)
    }
  }
}

test("admission publishes only after work and its immediate wake persist", async () => {
  const f = fixture()
  let staged = false
  await f.scheduler.admit(async () => { staged = true }, () => {
    expect(staged).toBe(true)
    expect(f.persisted()).toBe(true)
    expect(f.alarm()).toBeLessThanOrEqual(Date.now())
  })
  await f.fire(async () => {
    expect(f.persisted()).toBe(true)
    expect(f.alarm()).toBeGreaterThan(Date.now())
  })
  expect(f.alarm()).toBeNull()
})

test("a pass preserves later admissions and waits for their own pass", async () => {
  const arrivals = 3
  const f = fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await f.scheduler.admit(async () => {})
  const first = f.fire(async () => { started.resolve(); await release.promise })
  await started.promise
  let completed = 0
  const second = Promise.all(Array.from({ length: arrivals }, () =>
    f.scheduler.wakeAndWait().then(() => { completed++ })))
  await f.scheduler.admit(async () => {})
  release.resolve()
  await first
  expect(completed).toBe(0)
  expect(f.alarm()).toBeLessThanOrEqual(Date.now())
  await f.fire(async () => {})
  await second
  expect(completed).toBe(arrivals)
  expect(f.alarm()).toBeNull()
})

test("failed passes reject covered callers, retain recovery, and permit retry", async () => {
  const f = fixture()
  const failure = new Error("setup unavailable")
  const waiting = f.scheduler.wakeAndWait().catch((cause: unknown) => cause)
  await f.scheduler.admit(async () => {})
  await expect(f.fire(async () => { throw failure })).rejects.toBe(failure)
  expect(await waiting).toBe(failure)
  expect(f.alarm()).toBeGreaterThan(Date.now())
  const retry = f.scheduler.wakeAndWait()
  await f.scheduler.admit(async () => {})
  await f.fire(async () => {})
  await retry
  expect(f.alarm()).toBeNull()
})

test("a completed pass restores a future method deadline", async () => {
  const f = fixture()
  const deadline = Date.now() + 120_000
  await f.storage.setAlarm(deadline)
  await f.scheduler.admit(async () => {})
  expect(f.alarm()).toBeLessThan(deadline)
  await f.fire(async () => {}, () => f.storage.setAlarm(deadline))
  expect(f.alarm()).toBe(deadline)
})

test("concurrent alarms join one execution", async () => {
  const f = fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let passes = 0
  const first = f.fire(async () => { passes++; started.resolve(); await release.promise })
  await started.promise
  const second = f.scheduler.run(async () => { passes++ }, async () => {})
  release.resolve()
  await Promise.all([first, second])
  expect(passes).toBe(1)
})
