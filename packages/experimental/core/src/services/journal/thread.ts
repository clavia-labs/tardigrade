import { isDeepStrictEqual } from "node:util"
import { Clock, Effect, Schema } from "effect"
import { RecordMetadata, JournalConflict, type MessageJournal, type Recorded } from "../journal"
import { RuntimeError } from "../../runtime/effects"
import { StateInitialised } from "../../initial-state"
import { ThreadCreated, type ThreadCoordinate } from "../../actor/thread"

export interface ThreadJournal<Event extends object> extends MessageJournal<Event> {
  readonly readFirst: Effect.Effect<Recorded<Event> | undefined, Error>
}

const decodeCreation = (record: Recorded<object>) => Schema.decodeUnknownEffect(ThreadCreated)(record.event).pipe(
  Effect.tap(() => Schema.decodeEffect(RecordMetadata)(record)),
  Effect.mapError(RuntimeError.from),
)

// readThreadCreation validates an addressed journal's creation record before its runtime opens.
export const readThreadCreation = <Event extends object>(journal: ThreadJournal<Event>, address: ThreadCoordinate) => Effect.gen(function* () {
  const first = yield* journal.readFirst
  if (!first) return yield* Effect.fail(new RuntimeError("Thread journal has no creation record"))
  const created = yield* decodeCreation(first)
  if (!isDeepStrictEqual(created.address, address)) return yield* Effect.fail(new RuntimeError("Thread creation address differs from its journal"))
  return created
})

// initializeThread conditionally commits creation at position zero and validates the recorded lineage on reuse.
export const initializeThread = <Event extends object>(journal: ThreadJournal<Event>, input: ThreadCreated, initialState?: StateInitialised) => Effect.gen(function* () {
  const created = yield* Schema.decodeEffect(ThreadCreated)(input).pipe(Effect.mapError(RuntimeError.from))
  const seeded = initialState === undefined ? undefined : yield* Schema.decodeEffect(StateInitialised)(initialState).pipe(Effect.mapError(RuntimeError.from))
  const validate = (record: Recorded<Event>) => Effect.gen(function* () {
    const previous = yield* decodeCreation(record)
    if (!isDeepStrictEqual(previous, created)) return yield* Effect.fail(new RuntimeError("Thread creation lineage differs from its allocation"))
    if (seeded !== undefined) {
      const records = yield* journal.readAfter(1)
      if (!isDeepStrictEqual(records[0]?.event, seeded)) return yield* Effect.fail(new RuntimeError("Thread initial state differs from its allocation"))
    }
    yield* journal.acknowledge
  })
  const first = yield* journal.readFirst
  if (first) return yield* validate(first)
  const recordedAt = yield* Clock.currentTimeMillis
  yield* journal.append(0, [{ recordedAt, event: created }, ...(seeded === undefined ? [] : [{ recordedAt, event: seeded }])]).pipe(Effect.catch(error => Effect.gen(function* () {
    if (!(error instanceof JournalConflict)) return yield* Effect.fail(error)
    const recorded = yield* journal.readFirst
    if (!recorded) return yield* Effect.fail(error)
    yield* validate(recorded)
  })))
}).pipe(Effect.uninterruptible)
