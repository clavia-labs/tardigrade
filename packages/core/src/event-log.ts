import { Context, Effect } from "effect"
import type { Envelope } from "./envelope"

// EventLog is the one durable thing; append is the only mutation in the system (tla/Log.tla).
// State is a projection of it: replay is re-derivation, recovery is re-settling.
//
// A store that binds this port owes six guarantees.
//
// 1. Append only. A committed event binds forever; compaction appends, never deletes.
// 2. Total order per log. The watermark rises and never repeats.
// 3. One writer per log. The platform serializes appends per actor.
// 4. Atomic append of a batch. A crash leaves all of it or none of it.
// 5. Dedup by key. A keyed redelivery is absorbed; an absorbed append leaves `head` unchanged.
// 6. Ordered tail from a watermark. `readFrom(mark)` returns exactly the events after `mark`.
//
// `head` is the store's own testimony of progress: the settle loop compares it instead of
// materializing the log (packages/core/src/actor.ts, settleActor).
export class EventLog extends Context.Tag("flamecast/EventLog")<
  EventLog,
  {
    readonly append: (events: ReadonlyArray<Envelope>) => Effect.Effect<void>
    readonly read: Effect.Effect<ReadonlyArray<Envelope>>
    readonly head: Effect.Effect<number>
    readonly readFrom: (mark: number) => Effect.Effect<ReadonlyArray<Envelope>>
  }
>() {}

// withWatermark derives `head` and `readFrom` for a store that only has `append` and `read`:
// the watermark is the event count. Correct for any append-only array binding; a real store
// answers from its own sequence column instead.
export const withWatermark = (store: {
  readonly append: (events: ReadonlyArray<Envelope>) => Effect.Effect<void>
  readonly read: Effect.Effect<ReadonlyArray<Envelope>>
}): Context.Tag.Service<EventLog> => ({
  ...store,
  head: Effect.map(store.read, (events) => events.length),
  readFrom: (mark) => Effect.map(store.read, (events) => events.slice(mark))
})

// KeyFragment is one package's key derivation for its own alphabet, its prefixes declared as
// data so composition can prove disjointness. The package owns the derivation (only it knows
// which field names an occurrence and what scope the id is unique in); the platform owns the
// minting (callId, execId, runId come from the recorded machinery) and the composition. The
// caller never supplies a key: our runtime sees intent, so identity derives instead of being
// requested (the Stripe header exists because HTTP is blind; this runtime is not).
export interface KeyFragment {
  readonly prefixes: ReadonlyArray<string>
  readonly keyOf: (e: Envelope) => string | undefined
}

// composeKeys folds fragments into one derivation, first answer wins. Two fragments claiming a
// prefix is a construction-time error: the collision would silently cross-absorb two packages'
// events, which is the exact class of quiet failure keys exist to prevent.
export const composeKeys = (...fragments: ReadonlyArray<KeyFragment>): ((e: Envelope) => string | undefined) => {
  const claimed = new Map<string, number>()
  fragments.forEach((fragment, i) => {
    for (const prefix of fragment.prefixes) {
      const prior = claimed.get(prefix)
      if (prior !== undefined) {
        throw new Error(`key prefix "${prefix}" claimed by fragments ${prior} and ${i}`)
      }
      claimed.set(prefix, i)
    }
  })
  return (e) => {
    for (const fragment of fragments) {
      const key = fragment.keyOf(e)
      if (key !== undefined) return key
    }
    return undefined
  }
}
