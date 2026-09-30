import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom } from "./atom"
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
