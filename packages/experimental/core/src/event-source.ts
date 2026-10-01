import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom } from "./atom"
import type { Recorded, RuntimeEvent } from "./journal"
import type { createStore } from "./store"

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

// createRecordSource appends aligned payload and metadata prefixes through a single source update.
export function createRecordSource<Event>() {
  const source = atom<{ readonly events: readonly RuntimeEvent<Event>[]; readonly records: readonly Recorded<Event>[] }>({ events: Object.freeze([]), records: Object.freeze([]) })
  return {
    events: atom(get => get(source).events).pipe(NativeAtom.withLabel("events")),
    records: atom(get => get(source).records).pipe(NativeAtom.withLabel("records")),
    append: (store: Pick<ReturnType<typeof createStore>, "get" | "set">, batch: readonly Recorded<Event>[]) => {
      if (!batch.length) return
      const previous = store.get(source)
      store.set(source, {
        events: Object.freeze([...previous.events, ...batch.map(record => record.event)]),
        records: Object.freeze([...previous.records, ...batch]),
      })
    },
  }
}
