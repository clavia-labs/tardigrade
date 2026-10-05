import { strict as assert } from "node:assert"
import { Deferred, Effect } from "effect"
import { createScheduler, RuntimeError, type ScheduledWake } from "@clavia/tardigrade-core"

export interface SchedulerFixture {
  readonly open: (options: Pick<Parameters<typeof createScheduler>[0], "deliver" | "policy">) => ReturnType<typeof createScheduler>
  readonly alarmAt: () => Promise<number | null>
}

export async function schedulerProperties(fixture: SchedulerFixture) {
  const delivered: string[] = []
  const scheduler = fixture.open({ deliver: wake => Effect.sync(() => { delivered.push(wake.id) }) })
  const later = Date.now() + 60_000
  await Effect.runPromise(scheduler.schedule({ id: "watchdog", target: "watchdog", dueAt: later }))
  await Effect.runPromise(scheduler.schedule({ id: "effect", target: "effect", dueAt: later + 1_000 }))
  assert.equal(await fixture.alarmAt(), later)
  await Effect.runPromise(scheduler.cancel("watchdog"))
  assert.equal(await fixture.alarmAt(), later + 1_000)
  await Effect.runPromise(scheduler.schedule({ id: "effect", target: "effect", dueAt: 1 }))
  const reopened = fixture.open({ deliver: wake => Effect.sync(() => { delivered.push(wake.id) }) })
  await Effect.runPromise(reopened.restore)
  assert.ok((await fixture.alarmAt())! >= 1 && (await fixture.alarmAt())! <= Date.now())
  await Effect.runPromise(reopened.alarm)
  await Effect.runPromise(reopened.alarm)
  assert.deepEqual(delivered, ["effect"])
  assert.equal(await fixture.alarmAt(), null)
}

export async function schedulerAcknowledgments(fixture: SchedulerFixture) {
  const entered = Deferred.makeUnsafe<ScheduledWake>()
  const release = Deferred.makeUnsafe<void>()
  const delivered: unknown[] = []
  let first = true
  const scheduler = fixture.open({ deliver: wake => {
    if (!first) return Effect.sync(() => { delivered.push(wake.target) })
    first = false
    return Deferred.succeed(entered, wake).pipe(Effect.andThen(Deferred.await(release)))
  } })
  await Effect.runPromise(scheduler.schedule({ id: "effect", target: "old", dueAt: 1 }))
  const delivery = Effect.runPromise(scheduler.alarm)
  await Effect.runPromise(Deferred.await(entered))
  await Effect.runPromise(scheduler.cancel("effect"))
  await Effect.runPromise(scheduler.schedule({ id: "effect", target: "replacement", dueAt: 2 }))
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await delivery
  assert.ok((await fixture.alarmAt())! >= 2 && (await fixture.alarmAt())! <= Date.now())
  await Effect.runPromise(scheduler.alarm)
  assert.deepEqual(delivered, ["replacement"])
  assert.equal(await fixture.alarmAt(), null)

  const failing = fixture.open({ deliver: () => Effect.fail(new RuntimeError("not acknowledged")), policy: { deliveryRetryMs: 60_000 } })
  await Effect.runPromise(failing.schedule({ id: "unacknowledged", target: null, dueAt: 1 }))
  await Effect.runPromise(failing.alarm)
  assert.ok((await fixture.alarmAt())! > Date.now())
  await Effect.runPromise(failing.cancel("unacknowledged"))
  assert.equal(await fixture.alarmAt(), null)
}
