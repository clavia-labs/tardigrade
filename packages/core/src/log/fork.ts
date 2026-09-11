import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { isThreadCreated } from "../interaction/relations"
import type { AppendResult, ThreadEventStore } from "./service"

// ForkUntil names a prefix bound as a 1-based sequence or as an event id (fork.test.ts).
export const ForkUntil = Schema.Union([
  Schema.Int.pipe(Schema.check(Schema.makeFilter((value: number) => value >= 1, { title: "at or above one" }))),
  Schema.NonEmptyString
])

export type ForkUntil = typeof ForkUntil.Type

// ThreadForked records that this log was copied from a source prefix (host.forkThread; fork.test.ts).
export const ThreadForked = Schema.Struct({
  type: Schema.Literal("ThreadForked"),
  sourceThread: Schema.NonEmptyString,
  until: ForkUntil,
  forkedAt: Schema.Finite
})

export type ThreadForked = typeof ThreadForked.Type

// threadForked constructs a validated fork fact. Sequence 0 and empty source ids are refused.
export const threadForked = (fields: {
  readonly sourceThread: string
  readonly until: ForkUntil
  readonly forkedAt: number
}): ThreadForked => Schema.decodeSync(ThreadForked)({ type: "ThreadForked", ...fields })

// isThreadForked reports a valid fork fact. A malformed record is not a fork (fork.test.ts).
export const isThreadForked = (event: Event | undefined): event is ThreadForked =>
  event !== undefined && Schema.is(ThreadForked)(event)

// eventIdentityOf reads the checkpoint id a CLI `--until` value can name.
export const eventIdentityOf = (event: Event): string | undefined => {
  const value = event as { readonly id?: unknown; readonly callId?: unknown }
  if (typeof value.id === "string" && value.id.length > 0) return value.id
  if (typeof value.callId === "string" && value.callId.length > 0) return value.callId
  return undefined
}

// forkUntilOf normalizes a caller checkpoint. A digit string that is a positive integer is a sequence (fork.test.ts).
export const forkUntilOf = (until: number | string): ForkUntil => {
  if (typeof until === "number") {
    if (!Number.isSafeInteger(until) || until < 1) {
      throw new Error(`checkpoint sequence must be a positive integer, got ${until}`)
    }
    return until
  }
  if (/^[1-9]\d*$/.test(until)) {
    const seq = Number(until)
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new Error(`checkpoint sequence must be a positive integer, got ${until}`)
    }
    return seq
  }
  if (until.length === 0) throw new Error("checkpoint id must be nonempty")
  return until
}

// prefixUntil returns the inclusive source prefix through `until`. A missing checkpoint throws (fork.test.ts).
export const prefixUntil = (events: ReadonlyArray<Event>, until: number | string): ReadonlyArray<Event> => {
  const checkpoint = forkUntilOf(until)
  if (typeof checkpoint === "number") {
    if (checkpoint > events.length) {
      throw new Error(`checkpoint sequence ${checkpoint} is past the log head ${events.length}`)
    }
    return events.slice(0, checkpoint)
  }
  const index = events.findIndex((event) => eventIdentityOf(event) === checkpoint)
  if (index === -1) throw new Error(`checkpoint id ${JSON.stringify(checkpoint)} is not in the log`)
  return events.slice(0, index + 1)
}

// copyPrefix appends a source prefix through the destination store's copyPrefix path (fork.test.ts).
export const copyPrefix = (
  dest: ThreadEventStore,
  events: ReadonlyArray<Event>
): ReturnType<ThreadEventStore["copyPrefix"]> => dest.copyPrefix(events)

export type CopyPrefixResult = AppendResult

// forkBatchOf drops the source ThreadCreated row and appends ThreadForked. Dest already holds its own identity (fork.test.ts).
export const forkBatchOf = (
  sourceEvents: ReadonlyArray<Event>,
  fields: { readonly sourceThread: string; readonly until: number | string; readonly forkedAt: number }
): ReadonlyArray<Event> => {
  const checkpoint = forkUntilOf(fields.until)
  const prefix = prefixUntil(sourceEvents, checkpoint)
  const history = isThreadCreated(prefix[0]) ? prefix.slice(1) : prefix
  return [...history, threadForked({ sourceThread: fields.sourceThread, until: checkpoint, forkedAt: fields.forkedAt })]
}

// matchingFork reports whether dest already recorded this source prefix (fork.test.ts).
export const matchingFork = (
  events: ReadonlyArray<Event>,
  sourceThread: string,
  until: number | string
): boolean => {
  const checkpoint = forkUntilOf(until)
  return events.some((event) =>
    isThreadForked(event) && event.sourceThread === sourceThread && event.until === checkpoint
  )
}
