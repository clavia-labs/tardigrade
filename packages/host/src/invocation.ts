import { cancellationDispositionOf, cancellationRequested, cancellationRequestIdOf } from "@clavia/tardigrade-core/interaction/cancellation"
import type { ActorMethodDeclaration } from "@clavia/tardigrade-core/actor/method"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorInvocationContextOf, type InvocationCoordinate } from "@clavia/tardigrade-core/interaction/invocation"
import { prepareInvocation } from "@clavia/tardigrade-core/interaction/prepare"

// existingInvocation preserves the recorded deadline when a caller retries (../../http/src/method-request.test.ts).
export const existingInvocation = (events: ReadonlyArray<Event>, reference: InvocationCoordinate) => {
  const context = actorInvocationContextOf(events, reference.invocation)
  return context?.deadlineAt === undefined ? undefined : { reference, deadlineAt: context.deadlineAt }
}

// prepareMethodInvocation returns the durable event and transport-independent receipt (../../http/src/method-request.test.ts).
export const prepareMethodInvocation = (options: Parameters<typeof prepareInvocation>[0]) => {
  const prepared = prepareInvocation(options)
  return { event: prepared.event, accepted: { reference: prepared.reference, deadlineAt: prepared.context.deadlineAt! } }
}

// methodRequestState selects an explicit epoch or the legacy current epoch before reading state.
export const methodRequestState = (
  events: ReadonlyArray<Event>, method: ActorMethodDeclaration,
  request: { readonly method: string; readonly id: string; readonly epoch?: number }
) => {
  const invocation = { method: request.method, id: request.id, epoch: request.epoch ?? method.currentEpoch(events, request.id) }
  return { invocation, state: method.state(events, invocation) }
}

// methodCancellationRequest classifies cancellation before a transport adapter responds.
export const methodCancellationRequest = (
  events: ReadonlyArray<Event>, method: ActorMethodDeclaration,
  request: { readonly method: string; readonly id: string; readonly epoch?: number }
) => {
  const { invocation, state } = methodRequestState(events, method, request)
  if (state === undefined) return { invocation, status: "unknown" as const }
  if (method.cancellation === undefined) return { invocation, status: "unsupported" as const }
  return { invocation, status: cancellationDispositionOf(events, method, invocation) ?? "unknown" as const }
}

// methodCancellationEvent constructs a cancellation event for an invocation.
export const methodCancellationEvent = (
  invocation: ReturnType<typeof methodRequestState>["invocation"], at: number, reason?: string
) => cancellationRequested({
  request: cancellationRequestIdOf(invocation), invocation, cause: "requested",
  ...(reason === undefined ? {} : { reason }), at
})

