import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { isThreadCreated, openChildInvocationsOf, sameThreadAddress } from "../interaction/relations"
import { ThreadAddress } from "../transport/endpoint"

// ThreadForked records that the rows before it were copied from a source thread. Its own row position is the fork boundary: rows copied = its seq - 1 (fork.test.ts).
export const ThreadForked = Schema.Struct({
  type: Schema.Literal("ThreadForked"),
  source: ThreadAddress,
  at: Schema.Finite
})

export type ThreadForked = typeof ThreadForked.Type

// threadForked constructs a validated fork fact.
export const threadForked = (fields: {
  readonly source: ThreadAddress
  readonly at: number
}): ThreadForked => Schema.decodeSync(ThreadForked)({ type: "ThreadForked", ...fields })

// isThreadForked reports a valid fork fact. A malformed record is not a fork (fork.test.ts).
export const isThreadForked = (event: Event | undefined): event is ThreadForked =>
  event !== undefined && Schema.is(ThreadForked)(event)

// ForkSeq is a 1-based source row.
export const ForkSeq = Schema.Int.pipe(Schema.check(Schema.makeFilter((value: number) => value >= 1, { title: "at or above one" })))

// ForkCheckpoint names a source position by row, or by the id of an event whose row the edge resolves (fork.test.ts).
export const ForkCheckpoint = Schema.Union([
  Schema.Struct({ seq: ForkSeq }),
  Schema.Struct({ event: Schema.NonEmptyString })
])

export type ForkCheckpoint = typeof ForkCheckpoint.Type

// checkpointSeqOf resolves a checkpoint to a row. An event id names the last row whose id or callId matches, so a shared callId includes its response. A missing id throws (fork.test.ts).
export const checkpointSeqOf = (events: ReadonlyArray<Event>, checkpoint: ForkCheckpoint): number => {
  if ("seq" in checkpoint) return checkpoint.seq
  const index = events.findLastIndex((event) => {
    const value = event as { readonly id?: unknown; readonly callId?: unknown }
    return value.id === checkpoint.event || value.callId === checkpoint.event
  })
  if (index === -1) throw new Error(`no event with id ${JSON.stringify(checkpoint.event)} is in the log`)
  return index + 1
}

// prefixOf returns source rows 1 through seq inclusive. A seq outside 1..events.length throws (fork.test.ts).
export const prefixOf = (events: ReadonlyArray<Event>, seq: number): ReadonlyArray<Event> => {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > events.length) {
    throw new Error(`checkpoint ${seq} is outside the log (1..${events.length})`)
  }
  return events.slice(0, seq)
}

// forkBatchOf returns the destination append batch: the source prefix without the source's ThreadCreated, then ThreadForked. A prefix with an open child invocation is refused, because the destination would wait forever on a reply addressed to the source (relations.ts, openChildInvocationsOf; fork.test.ts).
export const forkBatchOf = (
  sourceEvents: ReadonlyArray<Event>,
  seq: number,
  source: ThreadAddress,
  at: number
): ReadonlyArray<Event> => {
  const prefix = prefixOf(sourceEvents, seq)
  const open = openChildInvocationsOf(prefix)
  if (open.length > 0) {
    const named = open.map((link) => `${link.target} ${link.child.invocation.method}/${link.child.invocation.id}`).join(", ")
    throw new Error(`checkpoint ${seq} leaves ${open.length} child invocation${open.length === 1 ? "" : "s"} open: ${named}`)
  }
  const history = isThreadCreated(prefix[0]) ? prefix.slice(1) : prefix
  return [...history, threadForked({ source, at })]
}

// matchingFork reports whether dest already holds this batch: a ThreadForked from the same source at the row the batch would place it. The destination's own ThreadCreated occupies row 1, so the marker sits at index batch.length (fork.test.ts).
export const matchingFork = (destEvents: ReadonlyArray<Event>, batch: ReadonlyArray<Event>): boolean => {
  const expected = batch.at(-1)
  const recorded = destEvents[batch.length]
  return isThreadForked(expected) && isThreadForked(recorded) && sameThreadAddress(recorded.source, expected.source)
}
