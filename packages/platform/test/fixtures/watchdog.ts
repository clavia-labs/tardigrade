import { Effect } from "effect"
import type { WatchdogEntry, WatchdogStorage, WatchdogTransaction } from "@clavia/tardigrade-core"

// memoryWatchdog commits staged records and alarm changes together (bun/watchdog.test.ts).
export function memoryWatchdog(afterCommit: Effect.Effect<void> = Effect.void) {
  let records = new Map<string, WatchdogEntry>()
  let alarm: number | null = null
  const storage: WatchdogStorage = { transaction: work => Effect.suspend(() => {
    const staged = new Map(records)
    let nextAlarm = alarm
    const tx: WatchdogTransaction = {
      alarm: { set: at => Effect.sync(() => { nextAlarm = at }), clear: Effect.sync(() => { nextAlarm = null }) },
      get: key => Effect.sync(() => staged.get(key)),
      put: (key, entry) => Effect.sync(() => { staged.set(key, entry) }),
      delete: key => Effect.sync(() => { staged.delete(key) }), list: Effect.succeed(staged),
    }
    return work(tx).pipe(Effect.tap(() => Effect.sync(() => { records = staged; alarm = nextAlarm })), Effect.tap(() => afterCommit))
  }) }
  return { storage, records: () => records, alarm: () => alarm, consumeAlarm: () => { alarm = null } }
}
