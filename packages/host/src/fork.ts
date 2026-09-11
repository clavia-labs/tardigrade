import type { Event } from "@clavia/tardigrade-core/event"
import { isThreadCreated, threadCreatedOf } from "@clavia/tardigrade-core/interaction/relations"
import { forkBatchOf, forkUntilOf, matchingFork } from "@clavia/tardigrade-core/log"
import type { ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"

// ForkThreadRequest copies a source prefix onto a new root (fork.test.ts, host.test.ts).
export interface ForkThreadRequest {
  readonly source: string
  readonly until: number | string
  readonly name?: string
}

export type ForkCopyPlan =
  | { readonly existing: true }
  | { readonly events: ReadonlyArray<Event> }

// forkCopyPlan returns the dest append batch, or existing when this prefix is already recorded (packages/core/src/log/fork.ts).
export const forkCopyPlan = (
  sourceEvents: ReadonlyArray<Event>,
  destEvents: ReadonlyArray<Event>,
  request: {
    readonly source: string
    readonly until: number | string
    readonly dest: string
    readonly forkedAt: number
  }
): ForkCopyPlan => {
  if (sourceEvents.length === 0 || threadCreatedOf(sourceEvents) === undefined) {
    throw new Error(`No thread named ${JSON.stringify(request.source)} has ever existed.`)
  }
  if (request.dest === request.source) {
    throw new Error("a fork cannot target its source thread")
  }
  const until = forkUntilOf(request.until)
  if (matchingFork(destEvents, request.source, until)) return { existing: true }
  if (!(destEvents.length === 1 && isThreadCreated(destEvents[0]))) {
    throw new Error(`thread ${JSON.stringify(request.dest)} already has a log that is not this fork`)
  }
  return {
    events: forkBatchOf(sourceEvents, {
      sourceThread: request.source,
      until,
      forkedAt: request.forkedAt
    })
  }
}

// forkRootAllocation is the root request host.forkThread passes to allocate (http-threads.ts).
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
