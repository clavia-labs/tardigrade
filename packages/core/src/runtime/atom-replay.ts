import type { AtomReplay } from "../services/event-log"
import type { ObservedRecord } from "../services/journal"
import { initialStateSeed } from "../initialise"
import type { ReadonlyLog } from "./log-view"

// atomReplay adapts observed journal records for durable atom folding (platform/test/properties/runtime/atom-checkpoint.ts).
export const atomReplay = (records: ReadonlyLog<ObservedRecord<unknown>>): AtomReplay => {
  const seed = initialStateSeed(records)
  return { position: records.length, seed, originSeed: { value: seed }, read: from => records.slice(from) }
}
