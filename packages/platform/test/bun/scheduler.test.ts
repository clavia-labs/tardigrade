import { test } from "bun:test"
import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect } from "effect"
import { bunJournal } from "../../src/bun"
import { schedulerProperties, schedulerAcknowledgments } from "../properties/scheduler/wakes"

for (const property of [schedulerProperties, schedulerAcknowledgments]) test(`Bun SQLite ${property.name}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "tardie-scheduler-"))
  const journals: ReturnType<typeof bunJournal>[] = []
  let alarmAt: number | null = null
  try {
    await property({
      open: options => {
        const journal = bunJournal({ actor: "test", filename: join(root, "scheduler.sqlite"), scheduler: {
          ...options,
          alarm: { set: at => Effect.sync(() => { alarmAt = at }), clear: Effect.sync(() => { alarmAt = null }) },
        } })
        journals.push(journal)
        if (!journal.scheduler) throw new Error("Scheduler was not configured")
        return journal.scheduler
      },
      alarmAt: () => Promise.resolve(alarmAt),
    })
  } finally {
    for (const journal of journals) await Effect.runPromise(journal.close)
    await rm(root, { recursive: true, force: true })
  }
})

for (const mutation of ["schedule", "append"] as const) test(`concurrent journal ${mutation} preserves the earlier wake while alarm delivery is blocked`, async () => {
  const root = await mkdtemp(join(tmpdir(), "tardie-scheduler-order-"))
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  let alarmAt: number | null = null
  let first = true
  const journal = bunJournal({ actor: "test", filename: join(root, "scheduler.sqlite"), scheduler: {
    alarm: {
      set: at => Effect.gen(function* () {
        if (first) {
          first = false
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        alarmAt = at
      }),
      clear: Effect.sync(() => { alarmAt = null }),
    },
    deliver: () => Effect.void,
  } })
  try {
    const later = Date.now() + 60_000
    const earlier = later - 1_000
    const firstSchedule = Effect.runPromise(journal.scheduler!.schedule({ id: "later", target: null, dueAt: later }))
    await Effect.runPromise(Deferred.await(entered))
    const secondSchedule = Effect.runPromise(mutation === "schedule"
      ? journal.scheduler!.schedule({ id: "earlier", target: null, dueAt: earlier })
      : journal.append(0, [{ event: { type: "RetryScheduled", ref: { seq: 0, atom: "test", act: "work" }, attempt: 1, dueAt: earlier, reason: null } }]))
    await Bun.sleep(20)
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Promise.all([firstSchedule, secondSchedule])
    assert.equal(alarmAt, earlier)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(journal.close)
    await rm(root, { recursive: true, force: true })
  }
})
