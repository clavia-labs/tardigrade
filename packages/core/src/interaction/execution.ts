import { Clock, Context, Data, Effect } from "effect"
import { EventLog } from "../log"
import { Self } from "../runtime/reconciler"
import { actorCall } from "./invoke"
import type { ActorInvocationContext, InvocationCoordinate } from "./invocation"
import type { ActorMethods, ActorMethodInput, ActorMethodOutput } from "../actor/method"
import type { ThreadTarget } from "../actor/reference"

import type { ThreadCoordinate } from "../actor/coordinate"
import { childLineageOf, sameThreadAddress, threadCreatedOf } from "./relations"

// InvocationScope supplies the accepted caller context and interruption signal for replayable work.
export class InvocationScope extends Context.Service<InvocationScope, {
  readonly context: ActorInvocationContext
  readonly signal: AbortSignal
}>()("tardigrade/InvocationScope") {}

// InvocationSuspended marks a pending call for the reconciler.
export class InvocationSuspended extends Error {}

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
