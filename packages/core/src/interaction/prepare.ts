import { decodeInvocationCoordinate, type InvocationCoordinate, decodeActorInvocationContext, type ActorInvocationContext, sameInvocation } from "./invocation"

import { actorMethodTimeoutOf, type ActorMethodDeclaration } from "../actor/method"
import { invokedEventOf } from "./envelope"

export const invocationTimeoutOf = (method: ActorMethodDeclaration, timeoutMs?: number): number => {
  const resolved = actorMethodTimeoutOf(timeoutMs ?? method.timeoutMs)
  if (resolved > method.timeoutMs) throw new Error(`timeoutMs cannot exceed the method's declared ${method.timeoutMs}ms`)
  return resolved
}

// prepareInvocation validates input and prepares the context shared by HTTP and actor callers.
export const prepareInvocation = (options: {
  readonly reference: InvocationCoordinate
  readonly method: ActorMethodDeclaration
  readonly input: unknown
  readonly at: number
} & ({ readonly context: ActorInvocationContext; readonly parent?: never; readonly timeoutMs?: never } |
  { readonly context?: never; readonly parent?: ActorInvocationContext; readonly timeoutMs?: number })) => {
  const reference = decodeInvocationCoordinate(options.reference)
  let context: ActorInvocationContext
  if (options.context !== undefined) {
    context = decodeActorInvocationContext(options.context)
  } else {
    const deadlineAt = options.at + invocationTimeoutOf(options.method, options.timeoutMs)
    if (!Number.isSafeInteger(deadlineAt)) throw new Error("actor call deadlineAt must be a safe integer")
    context = decodeActorInvocationContext({
      invocation: reference.invocation,
      ...(options.parent === undefined ? {} : { parent: options.parent.invocation }),
      deadlineAt: Math.min(deadlineAt, options.parent?.deadlineAt ?? deadlineAt)
    })
  }
  if (!sameInvocation(context.invocation, reference.invocation)) throw new Error("invocation context does not match its reference")
  let event
  try {
    event = invokedEventOf(context, options.method.eventOf({ ...context, input: options.input, at: options.at }))
  } catch (failure) {
    throw new Error(`The input for method ${JSON.stringify(reference.invocation.method)} is invalid. ${failure instanceof Error ? failure.message : String(failure)}`)
  }
  return { reference, context, event }
}
