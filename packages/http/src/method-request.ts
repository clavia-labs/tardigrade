import type { Event } from "@clavia/tardigrade-core/event"
import { existingInvocation, prepareMethodInvocation } from "@clavia/tardigrade-host/invocation"
import type { InvocationCoordinate } from "@clavia/tardigrade-core/interaction"

// acceptedMethodRequest formats the HTTP receipt for an invocation coordinate.
export const acceptedMethodRequest = (reference: InvocationCoordinate, deadlineAt: number) => ({
  reference, actor: reference.target.instance, thread: reference.target.thread,
  method: reference.invocation.method, call: reference.invocation.id, deadlineAt
})

// existingMethodRequest preserves the deadline recorded for an HTTP retry.
export const existingMethodRequest = (events: ReadonlyArray<Event>, reference: InvocationCoordinate) => {
  const receipt = existingInvocation(events, reference)
  return receipt === undefined ? undefined : acceptedMethodRequest(receipt.reference, receipt.deadlineAt)
}

// prepareMethodRequest adds an HTTP receipt to a prepared invocation.
export const prepareMethodRequest = (options: Parameters<typeof prepareMethodInvocation>[0]) => {
  const prepared = prepareMethodInvocation(options)
  return { event: prepared.event, accepted: acceptedMethodRequest(prepared.accepted.reference, prepared.accepted.deadlineAt) }
}

// methodRequestLocation identifies the durable call returned by an HTTP invocation.
export const methodRequestLocation = (reference: InvocationCoordinate): string => {
  const { target, invocation } = reference
  return `/v1/actors/${encodeURIComponent(target.instance)}/threads/${encodeURIComponent(target.thread)}/methods/${encodeURIComponent(invocation.method)}/calls/${encodeURIComponent(invocation.id)}?actor=${encodeURIComponent(target.actor)}&epoch=${invocation.epoch}`
}

export { methodRequestState, methodCancellationRequest, methodCancellationEvent } from "@clavia/tardigrade-host/invocation"
