import type { Link } from "../transport/link"
import type { Event } from "../event"
import { formatThreadAddress, parseThreadAddress, isThreadAddress, type ThreadAddress } from "../transport/endpoint"
import type { ResponseReceived, CallTimedOut, CallDispatched, CancellationDispatched } from "./events"

import { invocationCoordinateKey, type InvocationCoordinate, type InvocationRef } from "./invocation"

import { invocationDetachedOf } from "./detach"

type RecordedCall = Event & { readonly id: string; readonly reference?: InvocationCoordinate }

// outgoingKey preserves the key format of recorded calls without an invocation reference.
export const outgoingKey = (event: Event): string => {
  const call = event as RecordedCall
  return call.reference === undefined ? String(call.id) : invocationCoordinateKey(call.reference)
}

// outgoingMatches retains call-ID lookup for legacy records so replay can apply its drift checks.
export const outgoingMatches = (event: Event, reference: InvocationCoordinate): boolean => {
  const call = event as RecordedCall
  return call.id === reference.invocation.id &&
    (call.reference === undefined || invocationCoordinateKey(call.reference) === invocationCoordinateKey(reference))
}

// outgoingReference preserves the identity format chosen by the recorded plan.
export const outgoingReference = (plan: { readonly reference?: InvocationCoordinate }): { readonly reference?: InvocationCoordinate } =>
  plan.reference === undefined ? {} : { reference: plan.reference }

// terminalInvocationRefOf reads the invocation owned by a terminal, including recorded legacy replies.
export const terminalInvocationRefOf = (event: Event): InvocationCoordinate | undefined => {
  const detached = invocationDetachedOf(event)
  if (detached?.direction === "outgoing") return detached.reference
  if (event.type !== "ResponseReceived" && event.type !== "CallTimedOut") return undefined
  const terminal = event as ResponseReceived | CallTimedOut
  const address = terminal.type === "ResponseReceived" ? terminal.from : terminal.target
  if (typeof address !== "string" || typeof terminal.method !== "string" || typeof terminal.call !== "string") return undefined
  if (terminal.reference !== undefined) {
    const reference = terminal.reference
    return reference.invocation.method === terminal.method && reference.invocation.id === terminal.call &&
      formatThreadAddress(reference.target) === address ? reference : undefined
  }
  try {
    return { target: parseThreadAddress(address), invocation: { method: terminal.method, id: terminal.call, epoch: terminal.epoch ?? 0 } }
  } catch {
    return undefined
  }
}

// terminalStorageKey preserves persisted deduplication keys independently of invocation matching.
export const terminalStorageKey = (terminal: { readonly call: string; readonly reference?: InvocationCoordinate }): string =>
  `mterm:${terminal.reference === undefined ? terminal.call : invocationCoordinateKey(terminal.reference)}`

export interface RecordedDispatch {
  readonly reference: InvocationCoordinate
  readonly terminal: Pick<CallTimedOut, "reference" | "epoch" | "call" | "method" | "target" | "timeoutMs" | "deadlineAt">
}

// recordedDispatchOf normalizes outgoing records while retaining their terminal storage format.
export const recordedDispatchOf = (event: Event): RecordedDispatch | undefined => {
  if (event.type !== "CallDispatched" && event.type !== "CancellationDispatched") return undefined
  const record = event as CallDispatched | CancellationDispatched
  const call = record.type === "CancellationDispatched" ? record.request : record.id
  const method = record.type === "CancellationDispatched" ? "$cancel" : record.method
  const epoch = record.type === "CancellationDispatched" ? 0 : record.epoch ?? 0
  if (typeof call !== "string" || typeof method !== "string" || typeof record.target !== "string" ||
    typeof record.timeoutMs !== "number" || !Number.isSafeInteger(record.deadlineAt) ||
    (record.type === "CancellationDispatched" && (!Number.isSafeInteger(record.timeoutMs) || record.timeoutMs < 1))) return undefined
  const reference = record.reference ?? {
    target: parseThreadAddress(record.target), invocation: { method, id: call, epoch }
  }
  return { reference, terminal: {
    ...outgoingReference(record), call, method, target: record.target,
    ...(epoch === 0 ? {} : { epoch }), timeoutMs: record.timeoutMs, deadlineAt: record.deadlineAt
  } }
}

export interface AcceptedCall {
  readonly owner: Event
  readonly id: string
  readonly invocation?: InvocationRef
  readonly link: Link<unknown, ThreadAddress>
}

// acceptedCallOf reads the accepted reply link and its recorded invocation, retaining legacy call IDs (respond.test.ts, log/fork.test.ts).
export const acceptedCallOf = (event: Event): AcceptedCall | undefined => {
  const candidate = event as { readonly id?: unknown; readonly call?: unknown; readonly link?: unknown }
  const context = typeof candidate.call === "object" && candidate.call !== null
    ? candidate.call as { readonly invocation?: unknown }
    : undefined
  const invocation = typeof context?.invocation === "object" && context.invocation !== null
    ? context.invocation as InvocationRef
    : undefined
  const id = typeof invocation?.id === "string" ? invocation.id : candidate.id
  if (typeof id !== "string" || typeof candidate.link !== "object" || candidate.link === null ||
    !("source" in candidate.link) || !("target" in candidate.link) || !isThreadAddress(candidate.link.target)) return undefined
  return { owner: event, id, ...(invocation === undefined ? {} : { invocation }),
    link: candidate.link as Link<unknown, ThreadAddress> }
}
