import { Effect } from "effect"
import { schedulerAlarm, type ScheduledWake, type WatchdogEntry, type WatchdogStorage, type WatchdogTransaction } from "@clavia/tardigrade-core"

// memoryWatchdog commits staged records and alarm changes together (bun/watchdog.test.ts).
export function memoryWatchdog(afterCommit: Effect.Effect<void> = Effect.void) {
  let records = new Map<string, WatchdogEntry>()
  let alarm: number | null = null
  let wakes = new Map<string, ScheduledWake>(), generation = 0
  const storage: WatchdogStorage = { transaction: work => Effect.suspend(() => {
    const staged = new Map(records)
    let nextAlarm = alarm, nextGeneration = generation
    const scheduled = new Map(wakes)
    const tx: WatchdogTransaction = {
      scheduler: {
        alarm: { set: at => Effect.sync(() => { nextAlarm = at }), clear: Effect.sync(() => { nextAlarm = null }) },
        allocateGeneration: Effect.sync(() => ++nextGeneration),
        get: id => Effect.sync(() => scheduled.get(id)), put: entry => Effect.sync(() => { scheduled.set(entry.id, entry) }),
        delete: id => Effect.sync(() => { scheduled.delete(id) }), list: Effect.succeed(scheduled),
      },
      get: key => Effect.sync(() => staged.get(key)),
      put: (key, entry) => Effect.sync(() => { staged.set(key, entry) }),
      delete: key => Effect.sync(() => { staged.delete(key) }), list: Effect.succeed(staged),
    }
    return work(tx).pipe(Effect.tap(() => schedulerAlarm(tx.scheduler)), Effect.tap(() => Effect.sync(() => { records = staged; wakes = scheduled; generation = nextGeneration; alarm = nextAlarm })), Effect.tap(() => afterCommit))
  }) }
  return { storage, records: () => records, alarm: () => alarm, consumeAlarm: () => { alarm = null } }
}
