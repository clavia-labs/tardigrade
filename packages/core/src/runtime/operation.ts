import { StateReference } from "../services/tree-state"
import type { DocumentSession } from "../services/tree-state"
import { Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { EffectRef, EffectDied, EffectCancelled, CancellationOutcome, ExecutionResult, effectKey } from "./effects"
import { StoredEffectRequested, EffectSettled, PromiseSettled, RetryScheduled, type EffectAcceptance } from "./events"
import { InputDigest, digestInput } from "./input-digest"

// DEFAULT_EFFECT_RESULT_COLD_MIN_BYTES retires large fulfilled results from checkpoint payloads (platform/test/properties/accepted-work.ts).
export const DEFAULT_EFFECT_RESULT_COLD_MIN_BYTES = 2 * 1024

export const StoredOperation = Schema.Struct({
  ref: EffectRef,
  request: StoredEffectRequested,
  execution: Schema.Struct({
    outcome: Schema.optionalKey(Schema.Union([Schema.toType(EffectSettled), EffectDied])),
    deferred: Schema.optionalKey(Schema.toType(EffectSettled)),
    promise: Schema.optionalKey(Schema.toType(PromiseSettled)),
    results: Schema.optionalKey(Schema.Struct({ value: Schema.optionalKey(StateReference), promise: Schema.optionalKey(StateReference) })),
    retry: Schema.optionalKey(RetryScheduled),
    // retired holds digests of the fulfilled values retireOutcome removed from outcome and promise.
    retired: Schema.optionalKey(Schema.Struct({ value: Schema.optionalKey(InputDigest), promise: Schema.optionalKey(InputDigest) })),
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

// retireOutcome replaces large fulfilled payloads with digests and optional cold references (platform/test/properties/accepted-work.ts).
export function retireOutcome<Operation extends AcceptedOperation<unknown>>(operation: Operation, minBytes: number, capture?: (value: Schema.Json) => string | undefined): Operation {
  if (!capture) return operation
  const settlement = operation.execution.outcome
  const promise = operation.execution.promise
  let execution = operation.execution
  if (settlement?.type === "EffectSettled" && settlement.outcome.status === "fulfilled" && !execution.retired?.value) {
    const result = Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value)
    const digest = result.type === "value" ? digestInput(result.value) : undefined
    if (result.type === "value" && digest && digest.bytes >= minBytes) {
      const reference = capture(result.value)
      execution = { ...execution, outcome: { ...settlement, outcome: { status: "fulfilled", value: { type: "value", value: null } } }, retired: { ...execution.retired, value: digest }, ...(reference === undefined ? {} : { results: { ...execution.results, value: reference } }) }
    }
  }
  if (promise?.result.status === "fulfilled" && !execution.retired?.promise) {
    const digest = digestInput(promise.result.value)
    if (digest.bytes >= minBytes) {
      const reference = capture(promise.result.value)
      execution = { ...execution, promise: { ...promise, result: { status: "fulfilled", value: null } }, retired: { ...execution.retired, promise: digest }, ...(reference === undefined ? {} : { results: { ...execution.results, promise: reference } }) }
    }
  }
  return execution === operation.execution ? operation : { ...operation, execution }
}

// readRetiredResult verifies cold storage or archived journal values against their retirement digest (platform/test/properties/accepted-work.ts).
export function readRetiredResult(operation: AcceptedOperation<unknown>, kind: "value" | "promise", documents: Pick<DocumentSession, "read" | "readResult">): Schema.Json {
  const reference = operation.execution.results?.[kind]
  const value = reference === undefined ? documents.readResult?.(operation.ref, kind) : documents.read(reference)
  if (value === undefined) throw new Error(`Act result payload is unavailable: ${effectKey(operation.ref)}`)
  const digest = operation.execution.retired?.[kind]
  if (digest && !isDeepStrictEqual(digestInput(value), digest)) throw new Error("Retired result digest mismatch")
  return value
}

// settlementResult reads a fulfilled value only from its matching settlement (platform/test/properties/accepted-work.ts).
export function settlementResult(event: unknown, ref: EffectRef, kind: "value" | "promise"): Schema.Json | undefined {
  if (kind === "value" && Schema.is(EffectSettled)(event) && effectKey(event.ref) === effectKey(ref) && event.outcome.status === "fulfilled") {
    const result = Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value)
    return result.type === "value" ? result.value : undefined
  }
  return kind === "promise" && Schema.is(PromiseSettled)(event) && effectKey(event.ref) === effectKey(ref) && event.result.status === "fulfilled" ? event.result.value : undefined
}

// sameRetired compares a redelivered settlement with the retired form of the recorded one by the digest of its value.
export function sameRetired(operation: AcceptedOperation<unknown>, event: EffectSettled | PromiseSettled): EffectSettled | PromiseSettled {
  const retired = operation.execution.retired
  if (event.type === "EffectSettled" && retired?.value && event.outcome.status === "fulfilled") {
    const result = Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value)
    if (result.type === "value" && isDeepStrictEqual(digestInput(result.value), retired.value)) return { ...event, outcome: { status: "fulfilled", value: { type: "value", value: null } } }
  }
  if (event.type === "PromiseSettled" && retired?.promise && event.result.status === "fulfilled" && isDeepStrictEqual(digestInput(event.result.value), retired.promise)) return { ...event, result: { status: "fulfilled", value: null } }
  return event
}

// operationComplete matches the lifecycles replay retires: settled values, settled promises without cleanup, and acknowledged cleanup.
export const operationComplete = (operation: AcceptedOperation<unknown>): boolean => operation.cleanup ? cleanupSucceeded(operation.cleanup.outcome) : operation.execution.promise !== undefined || settlementCompletesExecution(operationSettlement(operation))
