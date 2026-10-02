import { Context, Effect, Semaphore, Schema } from "effect"
import { createRecordSource } from "../event-source"
import { createStore } from "../../atoms/store"
import { EventLog } from "../../services/event-log"
import { RuntimeError } from "../effects"
import { CoreEvent, hasCoreEventType } from "../events"
import { MessageReceived as InboxMessageReceived, isMessageReceived } from "../../actor/message"
import { RecordMetadata, type Recorded } from "../../services/journal"
import { select } from "./thread"

// createJournalStore observes an append-only journal without executing actor effects; its caller refreshes and closes it.
export function createJournalStore<Event extends object>(options: {
  readonly schema: Schema.Schema<Event>
  readonly read: (after: number) => Effect.Effect<readonly Recorded<Event>[], Error>
}) {
  const records = createRecordSource<Event>()
  const source = createStore(Context.make(EventLog, { events: records.events, records: records.records }))
  const decode = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })
  const decodeMetadata = Schema.decodeUnknownSync(RecordMetadata)
  const decodeMessage = Schema.decodeUnknownSync(InboxMessageReceived, { onExcessProperty: "error" })
  const decodeCore = Schema.decodeUnknownSync(Schema.toType(CoreEvent), { onExcessProperty: "error" })
  let closed = false
  const lock = Semaphore.makeUnsafe(1)
  return {
    get: source.get,
    sub: source.sub,
    events: select(source, records.events),
    records: select(source, records.records),
    refresh: lock.withPermit(Effect.gen(function* () {
      if (closed) return yield* Effect.fail(new RuntimeError("Journal store is closed"))
      const current = source.get(records.records)
      const next = yield* options.read(current.length - 1)
      yield* Effect.try({ try: () => {
        for (const record of next) {
          const metadata = decodeMetadata(record)
          if (isMessageReceived(record.event) !== (metadata.message !== undefined)) throw new RuntimeError("Inbox records require message metadata")
          const { event } = record
          if ("effect" in event) throw new RuntimeError("Domain effect metadata is not supported")
          if (isMessageReceived(event)) { const message = decodeMessage(event); if (!metadata.message?.inReplyTo) decode(message.body) }
          else if (hasCoreEventType(event)) decodeCore(event)
          else decode(event)
        }
        if (!closed && next.length) records.append(source, next)
      }, catch: RuntimeError.from })
    })),
    close: Effect.sync(() => { closed = true }).pipe(Effect.andThen(lock.withPermit(Effect.sync(() => source.dispose())))),
  }
}
