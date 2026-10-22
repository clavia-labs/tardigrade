import { Schema } from "effect"
import { EffectRef, EffectDied, EffectCancelled, CancellationOutcome, ExecutionResult, effectKey } from "./effects"
import { CoreEvent, StoredEffectRequested, EffectSettled, PromiseSettled, RetryScheduled, type EffectAcceptance } from "./events"
import { RecordMetadata } from "../services/journal"

export const StoredOperation = Schema.Struct({
  ref: EffectRef,
  request: StoredEffectRequested,
  recordedAt: RecordMetadata.fields.recordedAt,
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
  readonly recordedAt?: number
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

// recordedOperation reconstructs a reference from durable journal facts for late-delivery validation.
export function recordedOperation(records: Iterable<{ readonly event: unknown; readonly recordedAt?: number }>, ref: EffectRef): StoredOperation | undefined {
  let operation: StoredOperation | undefined
  const key = effectKey(ref)
  for (const { event, recordedAt } of records) {
    if (!Schema.is(CoreEvent)(event) || !("ref" in event) || effectKey(event.ref) !== key) continue
    if (event.type === "EffectRequested") operation = { ref: event.ref, request: event, ...(recordedAt === undefined ? {} : { recordedAt }), execution: {} }
    else if (operation) {
      if (event.type === "EffectSettled") operation = { ...operation, execution: { ...operation.execution, outcome: event } }
      else if (event.type === "EffectDied") {
        const settlement = operationSettlement(operation)
        operation = { ...operation, execution: { ...operation.execution, outcome: event, ...(settlement ? { deferred: settlement } : {}) } }
      } else if (event.type === "PromiseSettled") operation = { ...operation, execution: { ...operation.execution, promise: event } }
      else if (event.type === "EffectCancelled") operation = { ...operation, cleanup: { request: event } }
      else if (event.type === "CancellationSettled" || event.type === "CancellationDied") {
        if (operation.cleanup) operation = { ...operation, cleanup: { ...operation.cleanup, outcome: event } }
      } else if (event.type === "RetryScheduled") {
        if (event.phase === "cancellation") {
          if (operation.cleanup) operation = { ...operation, cleanup: { ...operation.cleanup, retry: event } }
        } else operation = { ...operation, execution: { ...operation.execution, retry: event } }
      }
    }
  }
  return operation
}

// operationComplete identifies terminal execution or acknowledged cleanup (platform/test/properties/runtime/snapshot-lookups.ts).
export const operationComplete = (operation: AcceptedOperation<unknown>): boolean => operation.cleanup ? cleanupSucceeded(operation.cleanup.outcome) : operation.execution.outcome?.type === "EffectDied" || operation.execution.promise !== undefined || settlementCompletesExecution(operationSettlement(operation))
