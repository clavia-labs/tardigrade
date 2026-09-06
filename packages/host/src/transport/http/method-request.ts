import type { Event } from "@clavia/tardigrade-core/event"
import { actorInvocationContextOf } from "@clavia/tardigrade-core/interaction/invocation"
import { cancellationDispositionOf, cancellationRequested, cancellationRequestIdOf } from "@clavia/tardigrade-core/interaction/cancellation"
import { type ActorMethodDeclaration } from "@clavia/tardigrade-core/actor/method"
import { prepareInvocation, type InvocationCoordinate } from "@clavia/tardigrade-core/interaction"

// acceptedMethodRequest formats the HTTP receipt for an invocation coordinate.
export const acceptedMethodRequest = (reference: InvocationCoordinate, deadlineAt: number) => ({
  reference, actor: reference.target.instance, thread: reference.target.thread,
  method: reference.invocation.method, call: reference.invocation.id, deadlineAt
})

// existingMethodRequest preserves the deadline recorded for an HTTP retry.
export const existingMethodRequest = (events: ReadonlyArray<Event>, reference: InvocationCoordinate) => {
  const context = actorInvocationContextOf(events, reference.invocation)
  return context?.deadlineAt === undefined ? undefined : acceptedMethodRequest(reference, context.deadlineAt)
}

// prepareMethodRequest prepares a new HTTP invocation and its receipt.
export const prepareMethodRequest = (options: {
  readonly reference: InvocationCoordinate
  readonly method: ActorMethodDeclaration
  readonly input: unknown
  readonly at: number
  readonly timeoutMs?: number
}) => {
  const prepared = prepareInvocation(options)
  return { event: prepared.event, accepted: acceptedMethodRequest(prepared.reference, prepared.context.deadlineAt!) }
}

// methodRequestState selects an explicit epoch or the legacy current epoch before reading state.
export const methodRequestState = (
  events: ReadonlyArray<Event>, method: ActorMethodDeclaration,
  request: { readonly method: string; readonly id: string; readonly epoch?: number }
) => {
  const invocation = { method: request.method, id: request.id, epoch: request.epoch ?? method.currentEpoch(events, request.id) }
  return { invocation, state: method.state(events, invocation) }
}

// methodCancellationRequest classifies cancellation before an adapter chooses its HTTP response.
export const methodCancellationRequest = (
  events: ReadonlyArray<Event>, method: ActorMethodDeclaration,
  request: { readonly method: string; readonly id: string; readonly epoch?: number }
) => {
  const { invocation, state } = methodRequestState(events, method, request)
  if (state === undefined) return { invocation, status: "unknown" as const }
  if (method.cancellation === undefined) return { invocation, status: "unsupported" as const }
  return { invocation, status: cancellationDispositionOf(events, method, invocation) ?? "unknown" as const }
}

// methodCancellationEvent constructs the cancellation shared by HTTP adapters.
export const methodCancellationEvent = (
  invocation: ReturnType<typeof methodRequestState>["invocation"], at: number, reason?: string
) => cancellationRequested({
  request: cancellationRequestIdOf(invocation), invocation, cause: "requested",
  ...(reason === undefined ? {} : { reason }), at
})
