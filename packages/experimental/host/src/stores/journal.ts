import { Context, Schema } from "effect"
import { atom, createStore, EventLog, RuntimeError, type Recorded } from "@clavia/tardigrade-experimental-core"
import { select } from "./thread"

// createJournalStore observes an append-only journal without executing actor effects; its caller refreshes and closes it.
export function createJournalStore<Event extends object>(options: {
  readonly schema: Schema.Schema<Event>
  readonly read: (after: number) => Promise<readonly Recorded<Event>[]>
}) {
  const records = atom<readonly Recorded<Event>[]>([])
  const domain = atom(get => get(records).map(({ effect: _effect, ...event }) => event))
  const source = createStore(Context.make(EventLog, { events: domain }))
  const decode = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })
  let closed = false
  let pending: Promise<void> = Promise.resolve()
  return {
    get: source.get,
    sub: source.sub,
    events: select(source, records),
    refresh: () => {
      const refresh = async () => {
        if (closed) throw new RuntimeError("Journal store is closed")
        const current = source.get(records)
        const next = await options.read(current.length - 1)
        for (const { effect: _effect, ...event } of next) decode(event)
        if (!closed && next.length) source.set(records, [...current, ...next])
      }
      const result = pending.then(refresh)
      pending = result.catch(() => {})
      return result
    },
    close: async () => { closed = true; await pending; source.dispose() },
  }
}
