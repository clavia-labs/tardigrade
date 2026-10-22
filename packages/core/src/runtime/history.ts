import { Schema } from "effect"
import { CoreEvent } from "./events"
import { effectKey, RuntimeError, type EffectRef } from "./effects"
import { LogView, type ReadonlyLog } from "./log-view"
import type { Recorded } from "../services/journal"

export interface ReplayHistory<Event> {
  readonly readRange: (from: number, to: number) => ReadonlyLog<Recorded<Event>>
  readonly readOperation: (ref: EffectRef, position: number) => ReadonlyLog<Recorded<Event>>
  readonly append: (position: number, batch: readonly Recorded<Event>[]) => ReplayHistory<Event>
}

// journalHistory reads externally committed records; its caller owns persistence (platform/test/properties/runtime/snapshot-lookups.ts).
export function journalHistory<Event>(readRange: ReplayHistory<Event>["readRange"], readOperation: ReplayHistory<Event>["readOperation"]): ReplayHistory<Event> {
  const history: ReplayHistory<Event> = { readRange, readOperation, append: () => history }
  return history
}

// memoryHistory owns immutable journal prefixes for standalone replay and branches (platform/test/properties/runtime/snapshot-lookups.ts).
export function memoryHistory<Event>(records: ReadonlyLog<Recorded<Event>>, offset: number, readBefore?: (position: number) => ReadonlyLog<Recorded<Event>>, readOperation?: ReplayHistory<Event>["readOperation"]): ReplayHistory<Event> {
  let prefix: ReadonlyLog<Recorded<Event>> | undefined
  const make = (log: LogView<Recorded<Event>>): ReplayHistory<Event> => {
    const readRange = (from: number, to: number): readonly Recorded<Event>[] => {
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to || to > offset + log.length) throw new RuntimeError("Journal range is unavailable")
      if (from >= offset) return log.slice(from - offset, to - offset)
      prefix ??= readBefore?.(offset)
      if (!prefix || prefix.length !== offset) throw new RuntimeError("Durable atom requires its checkpoint prefix")
      return [...prefix.slice(from, Math.min(to, offset)), ...log.slice(0, Math.max(0, to - offset))]
    }
    return {
      readRange,
      readOperation: readOperation ?? ((ref, position) => ref.seq >= position ? [] : readRange(ref.seq, position).filter(({ event }) => Schema.is(CoreEvent)(event) && "ref" in event && effectKey(event.ref) === effectKey(ref))),
      append: (position, batch) => make(log.take(position - offset).append(batch)),
    }
  }
  const empty: LogView<Recorded<Event>> = LogView.empty
  return make(empty.append(records.slice()))
}
