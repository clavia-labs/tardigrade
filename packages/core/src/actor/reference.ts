import type { ThreadCoordinate } from "./coordinate"

import type { Effect } from "effect"
import type { ActorMethods, ActorMethodInput, ActorMethodOutput } from "./method"
import { invokeMethod, type InvocationOptions, type InvocationFailed, type InvocationCancelled, type InvocationScope } from "../interaction/execution"
import type { EventLog } from "../log"
import type { Router } from "../transport/router"
import type { Self } from "../runtime/reconciler"

export { targetCoordinate, threadTarget, type ThreadTarget } from "./target"
import { targetCoordinate, targetMethods, callableThread, type CallableThread, type ThreadTarget } from "./target"

// ThreadRef exposes the actor's declared methods as callable Effects.
export type ThreadRef<Methods extends ActorMethods> = CallableThread<Methods, {
  readonly [Name in keyof Methods]: (
    input: ActorMethodInput<Methods[Name]>, options: InvocationOptions
  ) => Effect.Effect<ActorMethodOutput<Methods[Name]>, InvocationFailed | InvocationCancelled, InvocationScope | EventLog | Router | Self>
}>

// bindThreadMethods exposes declared methods as replayable calls on a thread reference.
export const bindThreadMethods = <Methods extends ActorMethods>(reference: ThreadTarget<Methods>, creationParent?: ThreadCoordinate): ThreadRef<Methods> => {
  const coordinate = targetCoordinate(reference)
  const calls: Record<string, unknown> = Object.create(null)
  const methods = targetMethods(reference)
  for (const name of Object.keys(methods)) {
    calls[name] = (input: ActorMethodInput<Methods[typeof name]>, options: InvocationOptions) =>
      invokeMethod(reference, name as Extract<keyof Methods, string>, input, options, creationParent)
  }
  return callableThread(coordinate, methods, calls, creationParent) as ThreadRef<Methods>
}
