import { Context, Effect, Semaphore, Schema } from "effect"
import { atom, createStore, EventLog, RuntimeError, CoreEvent, hasCoreEventType, type Recorded } from "@clavia/tardigrade-experimental-core"
import { select } from "./thread"

// createJournalStore observes an append-only journal without executing actor effects; its caller refreshes and closes it.
export function createJournalStore<Event extends object>(options: {
  readonly schema: Schema.Schema<Event>
  readonly read: (after: number) => Effect.Effect<readonly Recorded<Event>[], Error>
}) {
  const records = atom<readonly Recorded<Event>[]>([])
  const source = createStore(Context.make(EventLog, { events: records }))
  const decode = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })
  const decodeCore = Schema.decodeUnknownSync(Schema.toType(CoreEvent), { onExcessProperty: "error" })
  let closed = false
  const lock = Semaphore.makeUnsafe(1)
  return {
    get: source.get,
    sub: source.sub,
    events: select(source, records),
    refresh: lock.withPermit(Effect.gen(function* () {
      if (closed) return yield* Effect.fail(new RuntimeError("Journal store is closed"))
      const current = source.get(records)
      const next = yield* options.read(current.length - 1)
      yield* Effect.try({ try: () => {
        for (const event of next) {
          if ("effect" in event) throw new RuntimeError("Domain effect metadata is not supported")
          if (hasCoreEventType(event)) decodeCore(event)
          else decode(event)
        }
        if (!closed && next.length) source.set(records, [...current, ...next])
      }, catch: RuntimeError.from })
    })),
    close: Effect.sync(() => { closed = true }).pipe(Effect.andThen(lock.withPermit(Effect.sync(() => source.dispose())))),
  }
}
