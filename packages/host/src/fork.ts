import type { Event } from "@clavia/tardigrade-core/event"
import { threadCreatedOf } from "@clavia/tardigrade-core/interaction/relations"
import { checkpointSeqOf, forkBatchOf, matchingFork, type ForkCheckpoint } from "@clavia/tardigrade-core/log"
import type { ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"

// ForkThreadRequest copies source rows 1..seq onto a new root (fork.test.ts, host.test.ts).
export interface ForkThreadRequest {
  readonly source: string
  readonly seq: number
  readonly name?: string
}

// ForkRefusal classifies why a fork did not happen, so a transport can map each to a status without matching message text (packages/http/src/api.ts).
export type ForkRefusal = "unknown-source" | "checkpoint" | "occupied"

export class ForkRefused extends Error {
  readonly _tag = "ForkRefused"
  constructor(readonly refusal: ForkRefusal, message: string) {
    super(message)
    this.name = "ForkRefused"
  }
}

export const isForkRefused = (error: unknown): error is ForkRefused =>
  error instanceof ForkRefused || (typeof error === "object" && error !== null && (error as { readonly _tag?: unknown })._tag === "ForkRefused")

// resolveForkCheckpoint turns an edge checkpoint into a source row, refusing an unknown event id (fork.test.ts).
export const resolveForkCheckpoint = (sourceEvents: ReadonlyArray<Event>, checkpoint: ForkCheckpoint): number => {
  try {
    return checkpointSeqOf(sourceEvents, checkpoint)
  } catch (failure) {
    throw new ForkRefused("checkpoint", failure instanceof Error ? failure.message : String(failure))
  }
}

// forkBatchFor validates the source and builds the destination batch. Every refusal is a ForkRefused (fork.test.ts).
export const forkBatchFor = (
  sourceEvents: ReadonlyArray<Event>,
  request: {
    readonly source: ThreadAddress
    readonly seq: number
    readonly dest: string
  },
  at: number
): ReadonlyArray<Event> => {
  if (sourceEvents.length === 0 || threadCreatedOf(sourceEvents) === undefined) {
    throw new ForkRefused("unknown-source", `No thread named ${JSON.stringify(request.source.thread)} has ever existed.`)
  }
  if (request.dest === request.source.thread) {
    throw new ForkRefused("checkpoint", "a fork cannot target its source thread")
  }
  try {
    return forkBatchOf(sourceEvents, request.seq, request.source, request.dest, at)
  } catch (failure) {
    throw new ForkRefused("checkpoint", failure instanceof Error ? failure.message : String(failure))
  }
}

// forkOutcomeOf interprets a destination whose append was refused: the same fork already landed, or something else lives there (fork.test.ts).
export const forkOutcomeOf = (destEvents: ReadonlyArray<Event>, batch: ReadonlyArray<Event>, dest: string): "existing" =>
  {
    if (matchingFork(destEvents, batch)) return "existing"
    throw new ForkRefused("occupied", `thread ${JSON.stringify(dest)} already has a log that is not this fork`)
  }

// FORK_EXPECTED_HEAD is the head a freshly allocated root has: its ThreadCreated alone. The copy commits only at that head (packages/core/src/log/service.ts, AppendOptions).
export const FORK_EXPECTED_HEAD = 1

// forkRootAllocation is the root request host.forkThread passes to allocate. An unnamed destination mints a fresh key, so it is never idempotent (http-threads.ts).
export const forkRootAllocation = (
  scope: { readonly actor: string; readonly instance: string },
  name: string | undefined
): {
  readonly kind: "root"
  readonly coordinate: ThreadAddress
  readonly key?: string
} => name === undefined
  ? { kind: "root", coordinate: { ...scope, thread: "" }, key: crypto.randomUUID() }
  : { kind: "root", coordinate: { ...scope, thread: name } }
