import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { isMessageReceived } from "../actor/message"
import { atom } from "../atoms/atom"
import type { Recorded, RuntimeEvent, ObservedRecord } from "../services/journal"
import { EffectRequested } from "./events"
import { observeRequest } from "./input-digest"
import { Schema } from "effect"
import type { createStore } from "../atoms/store"
import { LogView } from "./log-view"

// createEventSource exposes an event prefix whose updates accept only appended batches.
export function createEventSource<Event = unknown>() {
  const records = atom<LogView<Event>>(LogView.empty)
  const events = atom(get => get(records)).pipe(NativeAtom.withLabel("events"))
  return {
    events,
    append: (store: Pick<ReturnType<typeof createStore>, "get" | "set">, batch: readonly Event[]) => {
      if (batch.length === 0) return
      store.set(records, store.get(records).append(batch))
    },
  }
}

// createRecordSource appends stored records and payload-free atom observations atomically (inputRepresentation).
export function createRecordSource<Event>() {
  const source = atom<{ readonly events: LogView<RuntimeEvent<Event>>; readonly records: LogView<Recorded<Event>>; readonly observed: LogView<ObservedRecord<Event>>; readonly observedEvents: LogView<Event | ObservedRecord<Event>["event"]> }>({ events: LogView.empty, records: LogView.empty, observed: LogView.empty, observedEvents: LogView.empty })
  const eventOf = <Entry extends { readonly event: unknown; readonly message?: { readonly inReplyTo?: unknown } }>(record: Entry) => isMessageReceived(record.event) && !record.message?.inReplyTo ? record.event.body as Event : record.event as Entry["event"]
  return {
    events: atom(get => get(source).events).pipe(NativeAtom.withLabel("events")),
    records: atom(get => get(source).records).pipe(NativeAtom.withLabel("records")),
    observedRecords: atom(get => get(source).observed).pipe(NativeAtom.withLabel("observedRecords")),
    observedEvents: atom(get => get(source).observedEvents).pipe(NativeAtom.withLabel("observedEvents")),
    append: (store: Pick<ReturnType<typeof createStore>, "get" | "set">, batch: readonly Recorded<Event>[]) => {
      if (!batch.length) return
      const previous = store.get(source)
      const observed = batch.map(record => Object.freeze({ ...record, event: Schema.is(EffectRequested)(record.event) ? Object.freeze(observeRequest(record.event)) : record.event }))
      store.set(source, {
        events: previous.events.append(batch.map(eventOf)),
        records: previous.records.append(batch),
        observed: previous.observed.append(observed),
        observedEvents: previous.observedEvents.append(observed.map(eventOf)),
      })
    },
  }
}
