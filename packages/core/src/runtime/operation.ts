import { Schema } from "effect"
import { EffectRef, EffectDied, EffectCancelled, CancellationOutcome, ExecutionResult } from "./effects"
import { StoredEffectRequested, EffectSettled, PromiseSettled, RetryScheduled, type EffectAcceptance } from "./events"

export const StoredOperation = Schema.Struct({
  ref: EffectRef,
  request: StoredEffectRequested,
  execution: Schema.Struct({
    outcome: Schema.optionalKey(Schema.Union([Schema.toType(EffectSettled), EffectDied])),
    deferred: Schema.optionalKey(Schema.toType(EffectSettled)),
    promise: Schema.optionalKey(Schema.toType(PromiseSettled)),
    retry: Schema.optionalKey(RetryScheduled),
  }),
  cleanup: Schema.optionalKey(Schema.Struct({
    request: EffectCancelled,
    outcome: Schema.optionalKey(CancellationOutcome),
    retry: Schema.optionalKey(RetryScheduled),
  })),
})
export type StoredOperation = typeof StoredOperation.Type

// AcceptedOperation groups execution and cleanup under the original accepted identity and request.
// accepted effect       -> execution work
// accepted cancellation -> cleanup work
export interface AcceptedOperation<Request = EffectAcceptance> {
  readonly ref: EffectRef
  readonly request: Request
  readonly execution: StoredOperation["execution"]
  readonly cleanup?: StoredOperation["cleanup"]
}

// operationSettlement retains deferred submission metadata when execution later dies.
export function operationSettlement(operation: AcceptedOperation<unknown> | undefined): EffectSettled | undefined {
  const outcome = operation?.execution.outcome
  return outcome?.type === "EffectSettled" ? outcome : operation?.execution.deferred
}

// cleanupSucceeded discharges cleanup only after a durable successful acknowledgement (quint/operationRecovery.qnt, cleanupComplete).
export const cleanupSucceeded = (outcome: CancellationOutcome | undefined): boolean => outcome?.type === "CancellationSettled" && outcome.outcome.status === "fulfilled"

// settlementCompletesExecution excludes deferred handles awaiting promise settlement (platform/test/properties/runtime/operation-lifecycle.ts).
export const settlementCompletesExecution = (settlement: EffectSettled | undefined): boolean => settlement !== undefined && (settlement.outcome.status === "rejected" || Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value).type === "value")

// cleanupOwed retains cleanup until its successful durable acknowledgement (quint/operationRecovery.qnt, cleanupComplete).
export const cleanupOwed = (operation: AcceptedOperation<unknown> | undefined): boolean => operation?.cleanup !== undefined && !cleanupSucceeded(operation.cleanup.outcome)

// cleanupRunnable excludes cleanup blocked by a final failure or defect (platform/test/properties/runtime/pending-input-recovery.ts).
export const cleanupRunnable = (operation: AcceptedOperation<unknown> | undefined): boolean => operation?.cleanup !== undefined && operation.cleanup.outcome === undefined

// cleanupSubmission admits a final handle required by accepted cleanup after execution stops (quint/operationRecovery.qnt, handleAdmitted).
export function cleanupSubmission(operation: AcceptedOperation<unknown> | undefined, event: EffectSettled): boolean {
  return cleanupOwed(operation) && event.outcome.status === "fulfilled" && Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value).type === "promise"
}
