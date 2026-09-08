import { Clock, Data, Effect, Option } from "effect"
import { EventLog } from "../log"
import { Self, OperationScope } from "../runtime/context"
import { actorCall } from "./invoke"
import type { InvocationCoordinate } from "./invocation"
import type { ActorMethods, ActorMethodInput, ActorMethodOutput } from "../actor/method"
import type { ThreadTarget } from "../actor/target"

import type { ThreadCoordinate } from "../actor/coordinate"
import { childLineageOf, sameThreadAddress, threadCreatedOf } from "./relations"

export { InvocationScope, InvocationSuspended } from "../runtime/context"
import { InvocationScope, InvocationSuspended } from "../runtime/context"

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

// invokeMethod replays a keyed call and yields execution while its result is pending (packages/host/src/invocation.test.ts).
// The enclosing action restarts from its beginning; side effects outside keyed calls must be replay-safe.
export const invokeMethod = <Methods extends ActorMethods, Name extends Extract<keyof Methods, string>>(
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
  const events = yield* log.read
  const created = threadCreatedOf(events)
  const lineage = creationParent !== undefined && sameThreadAddress(creationParent, self) && created !== undefined
    ? childLineageOf(created) : undefined
  const call = actorCall(events, {
    target, method, input,
    parent: { target: self, invocation: scope.context.invocation },
    context: scope.context,
    owner: Option.isSome(operation) ? operation.value : { type: "invocation", ref: scope.context.invocation },
    key: options.key,
    ...(lineage === undefined ? {} : { lineage }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  })
  switch (call.state.status) {
    case "completed": return call.state.output as ActorMethodOutput<Methods[Name]>
    case "failed": return yield* new InvocationFailed({ reference: call.reference, reason: call.state.error })
    case "cancelled": return yield* new InvocationCancelled({
      reference: call.reference, cause: call.state.cause,
      ...(call.state.reason === undefined ? {} : { reason: call.state.reason })
    })
    case "pending": {
      const transition = call.transitions[0]
      if (transition !== undefined) {
        const events = transition.kind === "intent"
          ? transition.events(transition.input, yield* Clock.currentTimeMillis)
          : yield* transition.act(transition.input, scope.signal)
        if (events.length > 0) yield* log.append(events)
      }
      return yield* Effect.die(new InvocationSuspended())
    }
  }
})
