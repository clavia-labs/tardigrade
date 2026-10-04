import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { isMessageReceived } from "../actor/message"
import { atom } from "../atoms/atom"
import type { Recorded, RuntimeEvent, ObservedRecord } from "../services/journal"
import { EffectRequested } from "./events"
import { observeRequest } from "./input-digest"
import { Schema } from "effect"
import type { createStore } from "../atoms/store"

// createEventSource exposes an event prefix whose updates accept only appended batches.
export function createEventSource<Event = unknown>() {
  const records = atom<readonly Event[]>(Object.freeze([]))
  const events = atom(get => get(records)).pipe(NativeAtom.withLabel("events"))
  return {
    events,
    append: (store: Pick<ReturnType<typeof createStore>, "get" | "set">, batch: readonly Event[]) => {
      if (batch.length === 0) return
      store.set(records, Object.freeze([...store.get(records), ...batch]))
    },
  }
}

// createRecordSource appends stored records and payload-free atom observations atomically (inputRepresentation).
export function createRecordSource<Event>() {
  const source = atom<{ readonly events: readonly RuntimeEvent<Event>[]; readonly records: readonly Recorded<Event>[]; readonly observed: readonly ObservedRecord<Event>[] }>({ events: Object.freeze([]), records: Object.freeze([]), observed: Object.freeze([]) })
  return {
    events: atom(get => get(source).events).pipe(NativeAtom.withLabel("events")),
    records: atom(get => get(source).records).pipe(NativeAtom.withLabel("records")),
    observedRecords: atom(get => get(source).observed).pipe(NativeAtom.withLabel("observedRecords")),
    observedEvents: atom(get => Object.freeze(get(source).observed.map(record => isMessageReceived(record.event) && !record.message?.inReplyTo ? record.event.body as Event : record.event))).pipe(NativeAtom.withLabel("observedEvents")),
    append: (store: Pick<ReturnType<typeof createStore>, "get" | "set">, batch: readonly Recorded<Event>[]) => {
      if (!batch.length) return
      const previous = store.get(source)
      store.set(source, {
        events: Object.freeze([...previous.events, ...batch.map(record => isMessageReceived(record.event) && !record.message?.inReplyTo ? record.event.body as Event : record.event)]),
        records: Object.freeze([...previous.records, ...batch]),
        observed: Object.freeze([...previous.observed, ...batch.map(record => Object.freeze({ ...record, event: Schema.is(EffectRequested)(record.event) ? Object.freeze(observeRequest(record.event)) : record.event }))]),
      })
    },
  }
}
