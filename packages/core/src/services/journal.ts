import { Schema, Effect } from "effect"
import { MessageMetadata, type MessageReceived } from "../actor/message"
import type { CoreEvent, ObservedCoreEvent, InvocationIdentity } from "../runtime/events"
import { EffectRef, RuntimeError } from "../runtime/effects"
import { EffectRequest } from "../runtime/events"

// RecordMetadata carries journal time and host-established delivery context separately from event payloads.
export const RecordMetadata = Schema.Struct({
  message: Schema.optionalKey(MessageMetadata),
  recordedAt: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))),
})
export type RecordMetadata = typeof RecordMetadata.Type

export type RuntimeEvent<Event> = Event | CoreEvent

export type JournalEvent<Event> = RuntimeEvent<Event> | MessageReceived

export interface Recorded<Event> extends RecordMetadata {
  readonly event: JournalEvent<Event>
}

export interface ObservedRecord<Event> extends RecordMetadata {
  readonly event: Event | ObservedCoreEvent
}

export interface StoredCheckpoint {
  readonly position: number
  readonly payload: Uint8Array
  readonly digest: string
}

export const PendingEffectInput = Schema.Struct({ ref: EffectRef, request: EffectRequest })
export type PendingEffectInput = typeof PendingEffectInput.Type

// EffectInputChanges commits accepted payloads and terminal releases with journal records (quint/checkpoint/inputLifecycle.qnt, inputRetained).
export interface EffectInputChanges {
  readonly put?: readonly PendingEffectInput[]
  readonly remove?: readonly EffectRef[]
}

// Journal accesses a local ordered event prefix synchronously; append commits a batch atomically or throws for a stale expected length (platform/test/properties/checkpoint-storage.ts).
export interface Journal<Event extends object> {
  // acknowledge encloses a synchronous local write in the host durability boundary, including physical wake staging (platform/test/workerd/watchdog.workers.ts).
  readonly acknowledge?: (write?: () => undefined) => Effect.Effect<void, Error>
  // lookupInvocation includes history before checkpoints; read failures remain errors. Callers serialize lookup and acceptance against the same journal prefix (quint/checkpoint/acceptanceBinding.qnt, uniqueInvocations).
  readonly lookupInvocation: (identity: InvocationIdentity) => InvocationLookup
  readonly read: () => readonly Recorded<Event>[]
  // readAfter returns the suffix starting at the consumed event count; positions beyond the journal length fail.
  readonly readAfter: (position: number) => readonly Recorded<Event>[]
  // readBefore returns exactly the consumed prefix; positions beyond the journal length fail (platform/test/properties/checkpoint-storage.ts).
  readonly readBefore: (position: number) => readonly Recorded<Event>[]
  readonly readInputs: () => readonly PendingEffectInput[]
  readonly append: (expectedLength: number, events: readonly Recorded<Event>[], inputs?: EffectInputChanges) => undefined
  readonly readCheckpoint: () => StoredCheckpoint | undefined
  readonly appendWithCheckpoint: (expectedLength: number, events: readonly Recorded<Event>[], checkpoint: StoredCheckpoint, inputs?: EffectInputChanges) => undefined
}

// InvocationLookup reports admission state and the original accepted reference (quint/checkpoint/acceptanceBinding.qnt, admissionSound). Unfinished cancellation remains pending until cleanup succeeds (quint/operationRecovery.qnt, cleanupComplete).
export type InvocationLookup =
  | { readonly status: "absent" }
  | { readonly status: "pending"; readonly ref: EffectRef }
  | { readonly status: "settled"; readonly ref: EffectRef }

export interface MessageJournal<Event extends object> extends Journal<Event> {
  readonly readMessage: (id: string) => { readonly position: number; readonly record: Recorded<Event> } | undefined
  readonly acknowledge: (write?: () => undefined) => Effect.Effect<void, Error>
}

export class JournalConflict extends Error { readonly _tag = "JournalConflict" }

// journalCall preserves synchronous journal failures at an Effect boundary (platform/test/properties/runtime/promise-settlement-order.ts).
// @effect-diagnostics-next-line globalErrorInEffectCatch:off: JournalConflict and PromiseNotReady retain their error identities at the synchronous storage boundary.
export const journalCall = <Value>(read: () => Value): Effect.Effect<Value, Error> => Effect.try({
  try: read,
  catch: cause => cause instanceof Error ? cause : RuntimeError.from(cause),
})

// journalCommit runs a synchronous write within the host acknowledgement boundary before external work (platform/test/workerd/watchdog.workers.ts).
export const journalCommit = (journal: Pick<Journal<object>, "acknowledge">, write: () => undefined): Effect.Effect<void, Error> => Effect.suspend(() => {
  const commit = (): undefined => {
    if (write() !== undefined) throw new RuntimeError("Journal writes must complete synchronously")
  }
  return journal.acknowledge ? journal.acknowledge(commit) : journalCall(commit)
})
