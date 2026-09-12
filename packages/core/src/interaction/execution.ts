import { Clock, Data, Effect, Option } from "effect"
import { EventLog } from "../log"
import { Self, OperationScope } from "../runtime/context"
import { actorCall, cancelInvocation, type ActorCancellationOptions } from "./invoke"
import { invocationCoordinateKey, type InvocationCoordinate } from "./invocation"
import type { ActorMethods, ActorMethodInput, ActorMethodOutput } from "../actor/method"
import type { ThreadTarget } from "../actor/target"
import type { ThreadRef } from "../actor/reference"
import { targetCoordinate, targetCreationParent, targetMethods } from "../actor/target"
import { durableOperations, type OperationHandle } from "./operation"

import type { ThreadCoordinate } from "../actor/coordinate"
import type { Router } from "../transport/router"
import { childLineageOf, sameThreadAddress, threadCreatedOf } from "./relations"
import { invocationResultOf, invocationTerminalOf } from "./result"

export { InvocationScope, InvocationSuspended } from "../runtime/context"
import { InvocationScope } from "../runtime/context"

export class InvocationFailed extends Data.TaggedError("InvocationFailed")<{
  readonly reference: InvocationCoordinate
  readonly reason: string
}> {}

export class InvocationCancelled extends Data.TaggedError("InvocationCancelled")<{
  readonly reference: InvocationCoordinate
  readonly cause: "requested" | "deadline"
  readonly reason?: string
}> {}

export interface InvocationOptions {
  readonly key: string
  readonly timeoutMs?: number
}

export type ActorOperationHandle = OperationHandle<InvocationCoordinate>

const appendTransition = (transition: ReturnType<typeof actorCall>["transitions"][number], signal: AbortSignal) =>
  Effect.gen(function* () {
    const log = yield* EventLog
    const events = transition.kind === "intent"
      ? transition.events(transition.input, yield* Clock.currentTimeMillis)
      : yield* transition.act(transition.input, signal)
    if (events.length > 0) yield* log.append(events)
  })

// startOperation durably dispatches one keyed actor operation and returns its replay-stable handle.
const startOperation = <Methods extends ActorMethods, Name extends Extract<keyof Methods, string>>(
  target: ThreadTarget<Methods>,
  method: Name,
  input: ActorMethodInput<Methods[Name]>,
  options: InvocationOptions,
  creationParent?: ThreadCoordinate
) => Effect.gen(function* () {
  const scope = yield* InvocationScope
  const operation = yield* Effect.serviceOption(OperationScope)
  const self = yield* Self
  const log = yield* EventLog
  const parent = creationParent ?? targetCreationParent(target)
  const created = threadCreatedOf(yield* log.read)
  const lineage = parent !== undefined && sameThreadAddress(parent, self) && created !== undefined
    ? childLineageOf(created) : undefined
  let call = actorCall(yield* log.read, {
    target, method, input,
    parent: { target: self, invocation: scope.context.invocation },
    context: scope.context,
    owner: Option.isSome(operation) ? operation.value : { type: "invocation", ref: scope.context.invocation },
    key: options.key,
    ...(lineage === undefined ? {} : { lineage }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  })
  while (call.transitions[0] !== undefined) {
    yield* appendTransition(call.transitions[0], scope.signal)
    call = actorCall(yield* log.read, {
      target, method, input,
      parent: { target: self, invocation: scope.context.invocation },
      context: scope.context,
      owner: Option.isSome(operation) ? operation.value : { type: "invocation", ref: scope.context.invocation },
      key: options.key,
      ...(lineage === undefined ? {} : { lineage }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    })
  }
  return call.reference
})

// awaitOperation returns a recorded terminal or parks on the handle's exact invocation.
const awaitOperation = <Methods extends ActorMethods, Name extends Extract<keyof Methods, string>>(
  target: ThreadTarget<Methods>,
  method: Name,
  reference: InvocationCoordinate
) => Effect.gen(function* () {
  const log = yield* EventLog
  if (!sameThreadAddress(reference.target, targetCoordinate(target)) || reference.invocation.method !== method) {
    return yield* Effect.die("actor operation handle does not match its bound target and method")
  }
  const response = invocationTerminalOf(yield* log.read, reference)
  if (response === undefined) return { status: "pending" as const, awaiting: invocationCoordinateKey(reference) }
  const declaration = targetMethods(target)[method]
  if (declaration === undefined) return yield* Effect.die(`actor operation method ${method} is undeclared`)
  const state = invocationResultOf(response, declaration.output)
  switch (state.status) {
    case "completed": return { status: "completed" as const, result: state.output }
    case "failed": return yield* new InvocationFailed({ reference, reason: state.error })
    case "cancelled": return yield* new InvocationCancelled({
      reference, cause: state.cause,
      ...(state.reason === undefined ? {} : { reason: state.reason })
    })
    case "pending": return { status: "pending" as const, awaiting: invocationCoordinateKey(reference) }
  }
})

// cancelOperation requests cancellation through the target method's declared control method.
const cancelOperation = <Methods extends ActorMethods>(
  target: ThreadTarget<Methods>,
  reference: InvocationCoordinate,
  options: ActorCancellationOptions
) => Effect.gen(function* () {
  const scope = yield* InvocationScope
  const log = yield* EventLog
  if (!sameThreadAddress(reference.target, targetCoordinate(target))) {
    return yield* Effect.die("actor operation handle does not match its bound target")
  }
  let call = cancelInvocation(yield* log.read, {
    ...options,
    target,
    invocation: reference.invocation
  })
  while (call.transitions[0] !== undefined) {
    yield* appendTransition(call.transitions[0], scope.signal)
    call = cancelInvocation(yield* log.read, {
      ...options,
      target,
      invocation: reference.invocation
    })
  }
  return call.reference
})

type ActorOperationsMethods<Target> = Target extends ThreadRef<infer Methods> ? Methods
  : Target extends ThreadTarget<infer Methods> ? Methods : never

export const actorOperations = <Target extends ThreadTarget, Name extends Extract<keyof ActorOperationsMethods<Target>, string>>(
  target: Target,
  method: Name,
  creationParent?: ThreadCoordinate
) => durableOperations<
  { readonly input: ActorMethodInput<ActorOperationsMethods<Target>[Name]>; readonly options: InvocationOptions },
  InvocationCoordinate,
  ActorMethodOutput<ActorOperationsMethods<Target>[Name]>,
  InvocationFailed | InvocationCancelled,
  InvocationScope | EventLog | Router | Self,
  ActorCancellationOptions,
  InvocationCoordinate
>({
  start: (request) =>
    startOperation(target, method, request.input, request.options, creationParent),
  read: (reference: InvocationCoordinate) => awaitOperation(target, method, reference),
  ...(targetMethods(target)[method]?.cancellation === undefined ? {} : {
    cancel: (reference: InvocationCoordinate, options: ActorCancellationOptions) => reference.invocation.method === method
      ? cancelOperation(target, reference, options)
      : Effect.die("actor operation handle does not match its bound method")
  })
})

// invokeMethod replays a keyed call and yields execution while its result is pending (packages/host/src/invocation.test.ts).
// The enclosing action restarts from its beginning; side effects outside keyed calls must be replay-safe.
export const invokeMethod = <Methods extends ActorMethods, Name extends Extract<keyof Methods, string>>(
  target: ThreadTarget<Methods>,
  method: Name,
  input: ActorMethodInput<Methods[Name]>,
  options: InvocationOptions,
  creationParent?: ThreadCoordinate
) => Effect.gen(function* () {
  const operations = actorOperations(target, method, creationParent)
  const handle = yield* operations.start({ input, options })
  return yield* operations.await(handle)
})
